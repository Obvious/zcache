var redis = require('redis')
var util = require('util')
var Q = require('kew')
var snappy = require('snappy')

var CacheInstance = require('./CacheInstance')
var ServerInfo = require('./ServerInfo')
var TimeoutError = require('./TimeoutError')

/**
 * A connection to a Redis server.
 *
 * @constructor
 * @param {string} host The host that runs the redis-server
 * @param {number} port The port that the redis-server listens to
 * @param {{requestTimeoutMs: (number|undefined), compressionEnabled: (boolean|undefined)}=} options Additional options for this connection.
 *     'requestTimeoutMs' specifies the timeout of a Redis request.
 * @extends CacheInstance
 */
function RedisConnection(host, port, options) {
  CacheInstance.call(this, options)

  this._isAvailable = false
  this._client = null
  this._host = host || null
  this._port = port || null
  this._uri = this._host + ':' + this._port
  this._bound_onConnect = this._onConnect.bind(this)
  this._bound_onError = this._onError.bind(this)
  this._bound_onEnd = this._onEnd.bind(this)

  // Controls if we turn on compression or not.
  // All cache values which are longer than the pivot are eligible for compression
  // Pivot and encoding prefix are hardcoded for now. Will revisit after
  // we know we are using snappy for sure
  this._snappyPivot = 750
  this._compressedPrefix = '@snappy@'
  this._uncompressedPrefix = '@orig@'
  this._compressionEnabled = (options && options.compressionEnabled) || false
}
util.inherits(RedisConnection, CacheInstance)

/** @override */
RedisConnection.prototype.isAvailable = function () {
  return this._isAvailable
}

/** @override */
RedisConnection.prototype.incr = function (key, increment) {
  if (increment === undefined) {
    increment = 1
  }

  var deferred = Q.defer()
  var params = [key, increment]
  this._client.incrby(params, this._makeNodeResolverWithTimeout(deferred, 'incrby', 'Redis [incr] key: ' + key))
  return deferred.promise
}

/** @override */
RedisConnection.prototype.set = function (key, val, maxAgeMs, setWhenNotExist) {
  return this._compress(val)
  .thenBound(function (compressedVal) {
    var params = [key, compressedVal, 'PX', maxAgeMs]
    if (setWhenNotExist) params.push('NX')

    var deferred = Q.defer()
    this._client.set(params, this._makeNodeResolverWithTimeout(deferred, 'set', 'Redis [set] key: ' + key))
    return deferred.promise
  }, this)
}

/** @override */
RedisConnection.prototype.mset = function (items, maxAgeMs, setWhenNotExist) {
  if (!items || !items.length) return Q.resolve(undefined)

  var compressedPromises = items.map(function (item) {
    return this._compress(item.value)
  }, this)
  return Q.all(compressedPromises)
  .thenBound(function (compressedValues) {
    var deferred = Q.defer()
    var commands = []

    var i, l
    if (setWhenNotExist) {
      // Use "SET" to set each key with a "NX" flag.
      for (i = 0, l = items.length; i < l; i++) {
        commands.push(['set', items[i].key, compressedValues[i], 'PX', maxAgeMs, 'NX'])
      }
    } else {
      // Use "MSET" to set all the keys and "EXPIRE" to set TTL for each key
      var msetCommand = ['MSET']
      commands.push(msetCommand)
      for (i = 0, l = items.length; i < l; i++) {
        var key = items[i].key
        // Append key value arguments to the set command.
        msetCommand.push(key, compressedValues[i])
        // Append an expire command.
        commands.push(['EXPIRE', key, Math.floor(maxAgeMs / 1000)])
      }
    }
    this._client.multi(commands).exec(
        this._makeNodeResolverWithTimeout(deferred, 'mset',
        'Redis [mset] key.0: ' + items[0].key + ' key.length: ' + items.length))
    return deferred.promise
  }, this)
}

/** @override */
RedisConnection.prototype.del = function (key) {
  var deferred = Q.defer()
  this._client.del(key,
      this._makeNodeResolverWithTimeout(deferred, 'del', 'Redis [del] key: ' + key))
  return deferred.promise
}

/** @override */
RedisConnection.prototype.get = function (key) {
  return this.mget([key])
    .then(returnFirstResult)
}

/** @override */
RedisConnection.prototype.mget = function (keys) {
  if (!keys || !keys.length) return Q.resolve([])
  var self = this
  var deferred = Q.defer()
  var opDesc = 'Redis [mget] key.0: ' + keys[0] + ' key.length: ' + keys.length
  this._client.mget(keys,
      this._makeNodeResolverWithTimeout(deferred, 'mget',
      opDesc))
  return deferred.promise
    .thenBound(function (vals) {
      // This function post-processes values from Redis client to
      // make cache miss result consistent with the API.
      //
      // Redis client returns null objects for cache misses, and we
      // turn them into undefined.
      for (var i = 0; i < vals.length; i++) {
        if (null === vals[i]) {
          vals[i] = undefined
        } else {
          //for real values determine if you need to uncompress
          vals[i] = this._uncompress(vals[i])
        }
      }
      return Q.all(vals)
    }, this)
    .then(this.getCountUpdater())
}

/** @override */
RedisConnection.prototype.getServerInfo = function () {
  var deferred = Q.defer()
  this._client.info(deferred.makeNodeResolver())
  return deferred.promise
    .then(function (infoCmdOutput) {
      var items = {}
      infoCmdOutput.split('\n')
        .filter(function(str) {return str.indexOf(':') > 0})
        .map(function(str) {return str.trim().split(':')})
        .map(function(item) {items[item[0]] = item[1]})
      var serverInfo = new ServerInfo()
      try {
        serverInfo.memoryBytes = parseInt(items['used_memory'], 10)
        serverInfo.memoryRssBytes = parseInt(items['used_memory_rss'], 10)
        serverInfo.evictedKeys = parseInt(items['evicted_keys'], 10)
        serverInfo.numOfConnections = parseInt(items['connected_clients'], 10)
        // The db0 key's value is something like: 'keys=12,expires=20'
        serverInfo.numOfKeys = parseInt(items['db0'].split(',')[0].split('=')[1], 10)
      } catch (e) {
        Q.reject(new Error('Malformatted output from the "INFO" command of Redis'))
      }
      return Q.resolve(serverInfo)
    })
}

/** @override */
RedisConnection.prototype.disconnect = function () {
  this._isAvailable = false
  this._client.quit()
  this.emit('disconnect')
}

/** @override */
RedisConnection.prototype.destroy = function () {
  this.disconnect()
  delete this._client
  this.emit('destroy')
}

/** @override */
RedisConnection.prototype.connect = function () {
  if (this._isAvailable) return

  if (this._client) {
    this._client.removeListener('connect', this._bound_onConnect)
    this._client.removeListener('error', this._bound_onError)
    this._client.removeListener('end', this._bound_onEnd)
  }

  this._client = redis.createClient(this._port, this._host)
  this._client.on('connect', this._bound_onConnect)
  this._client.on('error', this._bound_onError)
  this._client.on('end', this._bound_onEnd)
}

/** @override */
RedisConnection.prototype.getUrisByKey = function (key) {
  return [this._uri]
}

/**
 * Return the URI of this Redis server.
 *
 * @return {string} The URI of this Redis server.
 */
RedisConnection.prototype.getUri = function () {
  return this._uri
}

/** @override */
RedisConnection.prototype.getPendingRequestsCount = function () {
  return [{
    'uri': this._uri,
    'count': this._client.command_queue.length
  }]
}

RedisConnection.prototype._onConnect = function () {
  this._isAvailable = true
  this.emit('connect')
}

RedisConnection.prototype._onError = function (e) {
  this.emit('error', e)
}

RedisConnection.prototype._onEnd = function () {
  this._isAvailable = false
  this.emit('disconnect')
}

/**
 * A helper that returns a node-style callback function with a specified timeout.
 * It also records the response time of the request.
 *
 * @param {Q.Promise} deferred A deferred promise.
 * @param {string} opName The name of the operation. It should be one of these: 'get',
 *   'mget', 'set', 'mset' and 'del'.
 * @param {string} opDesc A short description of the operation
 * @return {function(Object, Object)} A node-style callback function.
 */
RedisConnection.prototype._makeNodeResolverWithTimeout = function (deferred, opName, opDesc) {
  // Indicates if this request has already timeout
  var isTimeout = false
  var startTime = Date.now()
  var self = this

  var timeout = setTimeout(function() {
    deferred.reject(new TimeoutError('Cache request timeout. ' + opDesc))
    isTimeout = true
    self._getTimeoutCounter(opName).inc()
  }, this._reqTimeoutMs)

  return function(err, data) {
    self.getStats(opName).update(Date.now() - startTime)
    if (!isTimeout) {
      clearTimeout(timeout)
      // TODO(Xiao): integrate opDesc into the error.
      if (err) deferred.reject(err)
      else deferred.resolve(data)
    }
    // TODO(Xiao): even if it's timeout, we may want to log the error message
    // if this request finally goes through but fails.
  }
}

/**
 * Private method controls how all cache values are encoded.
 *
 * @param {string|undefined|null} value Original cache value
 * @return {Q.Promise.<string|undefined|null>} Value encoded appropriately for the cache
 */
RedisConnection.prototype._compress = function (value) {
  if (!value || !this._compressionEnabled) {
    return Q.resolve(value)
  }

  if (value.length > this._snappyPivot) {
    try {
      return Q.nfcall(snappy.compress, value).thenBound(function (compressed) {
        return this._compressedPrefix + compressed.toString('base64')
      }, this)
    } catch (e) {
      console.warn("Compression failed: " + e.message)
      return Q.resolve(this._uncompressedPrefix + value)
    }
  } else {
    return Q.resolve(this._uncompressedPrefix + value)
  }
}

/**
 * Private Method that knows how to parsed encoded cache value and decode.
 *
 * @param {string|undefined|null} value Possibly encoded value retrieved from the cache.
 * @return {Q.Promise.<string|undefined|null>} The original input value
 */
RedisConnection.prototype._uncompress = function (value) {
  if (!value) return Q.resolve(value)

  // Note: always check prefixes even if compression is disabled, as there might
  // be entries from prior to disabling compression
  if (value.indexOf(this._compressedPrefix) === 0) {
    try {
      var compressedBuf = new Buffer(value.substring(this._compressedPrefix.length), 'base64')
      return Q.nfcall(snappy.uncompress, compressedBuf, {asBuffer: false})
    } catch (e) {
      console.warn("Decompression failed: " + e.message)
      return Q.resolve(undefined)
    }
  } else if (value.indexOf(this._uncompressedPrefix) === 0) {
    return Q.resolve(value.substring(this._uncompressedPrefix.length))
  } else {
    return Q.resolve(value)
  }
}

/**
 * Return the first result from a result set
 * @param  {Array.<Object>} results the results
 * @return {Object} the cached result
 */
function returnFirstResult(results) {
  return results[0]
}

module.exports = RedisConnection
