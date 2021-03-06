// Copyright 2014 A Medium Corporation

/**
 * @fileoverview Implementation of CacheInstance that will delegate to another
 * CacheInstance but will ensure that only one request for a given key is
 * outstanding at one time.
 *
 * If there are multiple concurrent gets the response from the first request
 * will be passed to the subsequent requests.
 *
 * Consider:
 *
 * R1 requests (A, B, C)
 * R2 requests (B, C, D)
 *
 * This will yield `mget`s for (A, B, C) and (D) that will be made to the
 * delegate, the results collated and returned to the callers.
 *
 * Deletes and sets will invalidate outstanding promises, such that any
 * subsequent requests will hit the delegate:
 *
 * R1 requests (A, B, C)
 * R2 sets (B)
 * R3 requests (B, C, D)
 *
 * Calls to underlying cache instance will be mget(A, B, C), set(B), mget(B, D).
 *
 * Caveat:
 * There are edge cases where we will over-invalidate the pending gets, we erred
 * on the conservative side:
 *  R1 requests (A)
 *  R2 deletes (A)
 *  R3 requests (A)
 *  R1 returns
 *  R4 requests (A) <- will hit delegate because response from R1 invalidated R3
 */


var CacheInstance = require('./CacheInstance')
var util = require('util')
var PartialResultError = require('./PartialResultError')
var Q = require('kew')


/**
 * @param {CacheInstance} delegate
 * @constructor
 * @extends {CacheInstance}
 */
function MultiplexingCache(delegate) {

  /**
   * CacheInstance that calls will be delegated to.
   * @private {CacheInstance}
   */
  this._delegate = delegate

  /**
   * Map of key->promise for pending gets.  The promise may return a map of
   * results, not just the key that was asked for, in order to reduce total
   * number of promises when doing mgets.
   * @type {Object.<Q.Promise.<Object.<*>>>}
   */
  this._pendingGets = {}

}
util.inherits(MultiplexingCache, CacheInstance)
module.exports = MultiplexingCache


/** @override */
MultiplexingCache.prototype.isAvailable = function () {
  return this._delegate.isAvailable()
}


/** @override */
MultiplexingCache.prototype.connect = function () {
  this._delegate.connect()
}


/** @override */
MultiplexingCache.prototype.disconnect = function () {
  this._delegate.disconnect()
}


/** @override */
MultiplexingCache.prototype.destroy = function () {
  this._delegate.destroy()
}


/** @override */
MultiplexingCache.prototype.getAccessCount = function () {
  return this._delegate.getAccessCount()
}


/** @override */
MultiplexingCache.prototype.getHitCount = function () {
  return this._delegate.getHitCount()
}


MultiplexingCache.prototype.resetCount = function () {
  this._delegate.resetCount()
}


/** @override */
MultiplexingCache.prototype.getServerInfo = function (key) {
  return this._delegate.getServerInfo(key)
}


/** @override */
MultiplexingCache.prototype.getStats = function (op) {
  return this._delegate.getStats(op)
}


/** @override */
MultiplexingCache.prototype.getTimeoutCount = function (op) {
  return this._delegate.getTimeoutCount(op)
}


/** @override */
MultiplexingCache.prototype.resetTimeoutCount = function (op) {
  return this._delegate.resetTimeoutCount(op)
}


/** @override */
MultiplexingCache.prototype.getPrettyStatsString = function (op) {
  return this._delegate.getPrettyStatsString(op)
}


/** @override */
MultiplexingCache.prototype.getUrisByKey = function (key) {
  return this._delegate.getUrisByKey(key)
}


/** @override */
MultiplexingCache.prototype.mset = function (items, maxAgeMs, setWhenNotExist) {
  this._invalidateKeys(items)
  return this._delegate.mset(items, maxAgeMs, setWhenNotExist)
}


/** @override */
MultiplexingCache.prototype.incr = function (key, increment) {
  this._invalidateKeys([key])
  return this._delegate.incr(key, increment)
}


/** @override */
MultiplexingCache.prototype.set = function (key, val, maxAgeMs, setWhenNotExist) {
  this._invalidateKeys([key])
  return this._delegate.set(key, val, maxAgeMs, setWhenNotExist)
}


/** @override */
MultiplexingCache.prototype.del = function (key) {
  this._invalidateKeys([key])
  return this._delegate.del(key)
}

/** @override */
MultiplexingCache.prototype.get = function (key) {
  if (!this._pendingGets[key]) {
    // Use `_mget` which returns a map, so that the result can also be consumed
    // by any `mget`s that make a request for the same key.
    this._pendingGets[key] = this._mget([key])
  }
  return this._pendingGets[key].then(this._extractValue(key))
}


/** @override */
MultiplexingCache.prototype.mget = function (keys) {
  var keysToFetch = []
  var promisesToWaitFor = []

  // If a get is outstanding for any key, then block on its associated promise.
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i]
    if (this._pendingGets[key]) {
      promisesToWaitFor.push(this._pendingGets[key])
    } else {
      keysToFetch.push(key)
    }
  }

  // If any keys still need fetching then do an actual mget for them.
  if (keysToFetch.length > 0) {
    var mgetPromise = this._mget(keysToFetch)
    promisesToWaitFor.push(mgetPromise)
    for (var j = 0; j < keysToFetch.length; j++) {
      this._pendingGets[keysToFetch[j]] = mgetPromise
    }
  }

  // Wait for all the promises to complete and aggregate the results.
  return Q.allSettled(promisesToWaitFor).thenBound(function (maps) {
    // Flatten the results from each promise.  In terms of Big-O this is less
    // efficient than building the result map using promises, but is less heavy.
    var aggregatedData = {}
    var aggregatedErrors = {}
    for (var i = 0; i < maps.length; i++) {
      if (maps[i]["state"] == "fulfilled") {
        for (var resultKey in maps[i]["value"]) {
          aggregatedData[resultKey] = maps[i]["value"][resultKey]
        }
      } else if (maps[i]["reason"]) {
          // The promise was not fulfilled. Set the error.
        aggregatedErrors[key] = maps[i]["reason"]
      }
    }
    if (Object.keys(aggregatedErrors).length == 0) {
      var result = []
      for (var i = 0; i < keys.length; i++) {
        result.push(aggregatedData[keys[i]])
      }
      return result
    } else {
      throw new PartialResultError(aggregatedData, aggregatedErrors)
    }
  }, this)
}

/**
 * Deletes the promise for a set of keys or objects.
 * @param {Array.<string|{key: string}>} keys
 * @private
 */
MultiplexingCache.prototype._invalidateKeys = function (keys) {
  for (var i = 0; i < keys.length; i++) {
    var key = typeof keys[i] == 'string' ? keys[i] : keys[i].key
    delete this._pendingGets[key]
  }
}


/**
 * Calls mget on the delegate and then returns a map of results from key->value.
 * @param {Array.<string>} keys
 * @return {Q.Promise.<Object>}
 * @private
 */
MultiplexingCache.prototype._mget = function (keys) {
  var self = this
  var invalidateFn = function (results) {
    self._invalidateKeys(keys)
    return results
  }
  var convertToMap = self._convertToMap(keys)
  return this._delegate.mget(keys)
    .then(function (results) {
      invalidateFn(results)
      return convertToMap(results)

    })
    .fail(function (e) {
      invalidateFn(null)
      return Q.reject(e)
    })
}


/**
 * Returns a promise callback that will convert a results array to a map using
 * the provided set of keys.
 * @param {Array.<string>} keys
 * @return {function (Array.<T>) : Object.<T>}
 * @private
 * @template T
 */
MultiplexingCache.prototype._convertToMap = function (keys) {
  return function (results) {
    if (!results) {
      return {}
    }
    var resultMap = {}
    for (var i = 0; i < keys.length; i++) {
      resultMap[keys[i]] = results[i]
    }
    return resultMap
  }
}


/** @override */
MultiplexingCache.prototype.getPendingRequestsCount = function () {
  return this._delegate.getPendingRequestsCount()
}


/**
 * Returns a promise callback that will extract the key from the resolved map.
 * @param {string} key
 * @return {function (Object) : Object}
 * @private
 */
MultiplexingCache.prototype._extractValue = function (key) {
  return function (map) {
    return map[key]
  }
}
