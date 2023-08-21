/**
 * @namespace cam
 * @description Common camera module
 * @author Andrew D.Laptev <a.d.laptev@gmail.com>
 * @licence MIT
 */

const http = require('http'),
    https = require('https'),
    crypto = require('crypto'),
    events = require('events'),
    url = require('url'),
    linerase = require('./utils').linerase,
    parseSOAPString = require('./utils').parseSOAPString,
    parseString = require('../../xml2js').parseString,
    stripPrefix = require('../../xml2js').processors.stripPrefix,
    emptyFn = function() {},
    guid = require('./utils').guid;
    
/**
 * @callback Cam~MessageCallback
 * @property {?Error} error
 * @property {?string} message
 */

/**
 * @callback Cam~ConnectionCallback
 * @property {?Error} error
 */

/**
 * Camera class
 * @param {object} options
 * @param {boolean} options.useSecure Set true if `https:`, defaults to false
 * @param {object} options.secureOpts Set options for https like ca, cert, ciphers, rejectUnauthorized, secureOptions, secureProtocol, etc.
 * @param {string} options.hostname
 * @param {string} [options.username]
 * @param {string} [options.password]
 * @param {number} [options.port=80]
 * @param {string} [options.path=/onvif/device_service]
 * @param {number} [options.timeout=15000]
 * @param {boolean} [options.autoconnect=true] Set false if the camera should not connect automatically. The callback will not be executed.
 * @param {boolean} [options.preserveAddress=false] Force using hostname and port from constructor for the services
 * @param {Cam~ConnectionCallback} [callback]
 * @fires Cam#rawRequest
 * @fires Cam#rawResponse
 * @fires Cam#connect
 * @fires Cam#event
 * @fires Cam#warning
 * @property presets
 * @class
 * @constructor
 * @extends events.EventEmitter
 * @example
 * var
 *   http = require('http'),
 *   Cam = require('onvif').Cam;
 *
 * new Cam({
 *   useSecure: <IS_SECURE>,
 *   secureOpts: {...<SECURE_OPTIONS>}
 *   hostname: <CAMERA_HOST>,
 *   username: <USERNAME>,
 *   password: <PASSWORD>
 * }, function(err) {
 *   this.absoluteMove({x: 1, y: 1, zoom: 1});
 *   this.getStreamUri({protocol:'RTSP'}, function(err, stream) {
 *     http.createServer(function (req, res) {
 *       res.writeHead(200, {'Content-Type': 'text/html'});
 *       res.end('<html><body>' +
 *         '<embed type="application/x-vlc-plugin" target="' + stream.uri + '"></embed>' +
 *         '</body></html>');
 *     }).listen(3030);
 *   });
 * });
 */
var Cam = function(options, callback) {
    events.EventEmitter.call(this);
    callback = callback || emptyFn;
    this.homey = options.homeyApp;
    this.useSecure = options.useSecure || false;
    this.secureOpts = options.secureOpts || {};
    this.hostname = options.hostname;
    this.username = options.username;
    this.password = options.password;
    this.port = options.port || (options.useSecure ? 443 : 80);
    this.path = options.path || '/onvif/device_service';
    this.timeout = options.timeout || 15000;
    this.agent = options.agent || false;
    /**
     * Force using hostname and port from constructor for the services
     * @type {boolean}
     */
    this.preserveAddress = options.preserveAddress || false;

    var ifaces = require('os').networkInterfaces();
    for (var dev in ifaces)
    {
        ifaces[dev].filter((details) => details.family === 'IPv4' && details.internal === false ? this.localAddress = details.address : undefined);
    }

    this.events = {};
    this.eventEmitter = new events.EventEmitter();
    /**
     * Bind event handling to the `event` event
     */
    this.on('newListener', function(name) {
        // if this is the first listener, start pulling subscription
        if (name === 'event' && this.listeners(name).length === 0) {
            setImmediate(function() {
                this._eventRequest();
            }.bind(this));
        }
    }.bind(this));

    if (options.autoconnect !== false) {
        setImmediate(function() {
            this.connect(callback);
        }.bind(this));
    }
};

// events.EventEmitter inheritance
// util.inherits(Cam, events.EventEmitter); // Do not inherit! Because the EventEmitter becomes static (same for all instances of Cam object)
Cam.prototype.addListener = function(eventName, listener)
{
    return this.eventEmitter.addListener(eventName, listener);
};
Cam.prototype.emit = function(event, ...data)
{
    return this.eventEmitter.emit(event, ...data);
};
Cam.prototype.eventNames = function()
{
    return this.eventEmitter.eventNames();
};
Cam.prototype.getMaxListeners = function()
{
    return this.eventEmitter.getMaxListeners();
};
Cam.prototype.listenerCount = function(eventName)
{
    return this.eventEmitter.listenerCount(eventName);
};
Cam.prototype.listeners = function(eventName)
{
    return this.eventEmitter.listeners(eventName);
};
Cam.prototype.off = function(eventName, listener)
{
    return this.eventEmitter.off(eventName, listener);
};
Cam.prototype.on = function(eventName, listener)
{
    return this.eventEmitter.on(eventName, listener);
};
Cam.prototype.once = function(eventName, listener)
{
    return this.eventEmitter.once(eventName, listener);
};
Cam.prototype.prependListener = function(eventName, listener)
{
    return this.eventEmitter.prependListener(eventName, listener);
};
Cam.prototype.prependOnceListener = function(eventName, listener)
{
    return this.eventEmitter.prependOnceListener(eventName, listener);
};
Cam.prototype.removeAllListeners = function(eventName)
{
    return this.eventEmitter.removeAllListeners(eventName);
};
Cam.prototype.removeListener = function(eventName, listener)
{
    return this.eventEmitter.removeListener(eventName, listener);
};
Cam.prototype.setMaxListeners = function(n)
{
    return this.eventEmitter.setMaxListeners(n);
};
Cam.prototype.rawListeners = function(eventName)
{
    return this.eventEmitter.rawListeners(eventName);
};

/**
 * Connect to the camera and fill device information properties
 * @param {Cam~ConnectionCallback} callback
 */
Cam.prototype.connect = function(callback)
{

    // Must execute getSystemDataAndTime (and wait for callback)
    // before any other ONVIF commands so that the time of the ONVIF device
    // is known

    this.getSystemDateAndTime(function(err, date, xml) {
        if (err) {
            this.homey.app.updateLog('getSystemDateAndTime error (' + this.hostname + '):' + this.homey.app.varToString(err), 3);
            return callback(err, null, xml);
        }
        this.getServices(true, function(err) {
            if (err) {
                this.homey.app.updateLog('getServices error (' + this.hostname + '):' + this.homey.app.varToString(err), 3);
                return this.getCapabilities(function(err, data, xml) {
                    if (err) {
                        this.homey.app.updateLog('getCapabilities error (' + this.hostname + '):' + this.homey.app.varToString(err), 3);
                        return callback(err, null, xml);
                    }
                    return callUpstartFunctions.call(this);
                }.bind(this));
            }
            if (this.media2Support) {
                // Check Media2 works (workaround a buggy D-Link DCS-8635LH camera). Disable Media2 if there is an error.
                // This is inefficient as we also call GetProfiles in the upstart function
                this.getProfiles(function(err) {
                    if (err) {
                        this.media2Support = false; // don't use media2
                    }
                    return callUpstartFunctions.call(this);
                }.bind(this));
            } else {
                return callUpstartFunctions.call(this);
            }
        }.bind(this));

        function callUpstartFunctions() {
            this.homey.app.updateLog('callUpstartFunctions (' + this.hostname + '): Started *****');

            // Profile S
            if (this.uri && this.uri.media) {
                // call functions synchronosly as it seems some cameras cant process more than one message at a time
                this.getProfiles(function(err) {
                    if (err) {
                        if (callback) {
                            callback(err);
                            return;
                        }
                    } else {
                        this.getVideoSources(function(err) {
                            if (err) {
                                if (callback) {
                                    callback(err);
                                    return;
                                }
                            } else {
                                this.getActiveSources();
                                /**
                                 * Indicates that device is connected.
                                 * @event Cam#connect
                                 */
                                this.emit('connect');
                                this.homey.app.updateLog('callUpstartFunctions (' + this.hostname + '): Finished -----');
                                if (callback) {
                                    return callback(err);
                                }
                            }
                        }.bind(this));
                    }
                }.bind(this));
            }
        }
    }.bind(this));
};

/**
 * @callback Cam~RequestCallback
 * @param {Error} err
 * @param {object} [response] message
 * @param {string} [xml] response
 */

/**
 * Common camera request
 * @param {object} options
 * @param {string} [options.service] Name of service (ptz, media, etc)
 * @param {string} options.body SOAP body
 * @param {string} [options.url] Defines another url to request instead of using the URLs from GetCapabilities/GetServices
 * @param {boolean} [options.ptz] make request to PTZ uri or not
 * @param {Cam~RequestCallback} callback response callback
 * @private
 */
Cam.prototype._request = function(options, callback){
    if (typeof callback !== 'function'){
        throw new Error('\'callback\' must be a function');
    }
    if (options.body === undefined) {
        throw new Error('\'options.body\' must be a defined');
    }

    // Generate the HTTP Content-Type 'action' string by parsing our outgoing ONVIF XML message with xml2js
    // xml2js returns a callback, so call _requestPart2 from the callback
    if (options.action == undefined || options.action == null) {
        let xml2jsOptions = {
            'xmlns': true, // Creates the $ns object that contains the full namepace and local name of each XML Tag
            tagNameProcessors: [stripPrefix] // Removes the namespace from each tag so we can parse Key:Value pairs of Tags
        };
        parseString(options.body, xml2jsOptions, (err, result) => {
            // Check for parsing errors
            if (err) {
                return callback(err);
            }
            // look for first Key:Value pairs that do not start with $ or $ns
            // for (const [key, value] of Object.entries(result['Envelope']['Body'][0])) {  // Node 7 or higher
            for (const key of Object.keys(result.Envelope.Body[0])) {
                const value = result.Envelope.Body[0][key];
                if (key.startsWith('$') == false) {
                    options.action = value[0]['$ns'].uri + '/' + value[0]['$ns'].local;
                    break;
                }
            }
            this._requestPart2.call(this, options, callback);
        });
    } else {
        this._requestPart2.call(this, options, callback);
    }
};

Cam.prototype._requestPart2 = function(options, callback) {

    var _this = this;
    var callbackExecuted = false;
    var reqOptions = {};
    if (options.url)
    {
        if (typeof options.url === 'string')
        {
            const myURL = new URL(options.url);
            reqOptions = {
                hostname: myURL.hostname,
                port: myURL.port,
                path: myURL.pathname + myURL.search
            };
        }
        else
        {
            reqOptions = {
                hostname: options.url.hostname,
                port: options.url.port,
                path: options.url.pathname + options.url.search
            };
        }
    }
    else
    {
        reqOptions = {
            hostname: this.hostname,
            port: this.port,
            agent: this.agent //Supports things like https://www.npmjs.com/package/proxy-agent which provide SOCKS5 and other connections
            ,
            path: options.service ?
                (this.uri[options.service] ? this.uri[options.service].path : options.service) : this.path,
            timeout: this.timeout
        };
    }
    reqOptions.agent = this.agent; //Supports things like https://www.npmjs.com/package/proxy-agent which provide SOCKS5 and other connections
    reqOptions.timeout = options.timeout ? options.timeout : this.timeout;
    reqOptions.headers = {
        'Content-Type': `application/soap+xml; charset: utf-8; action="${options.action}"`,
        'Content-Length': Buffer.byteLength(options.body, 'utf8'), //options.body.length chinese will be wrong here
        charset: 'utf-8'
    };

    reqOptions.method = 'POST';
    var httpLib = this.useSecure ? https : http;
    reqOptions = this.useSecure ? Object.assign({}, this.secureOpts, reqOptions) : reqOptions;
    _this.homey.app.updateLog('\n_request (' + _this.hostname + '): ' + _this.homey.app.varToString(reqOptions) + '\n' + _this.homey.app.varToString(options.body) + '\n', 3);

    var req = null;
    req = httpLib.request(reqOptions, res => {
        const statusCode = res.statusCode;
        var bufs = [],
            length = 0;
        res.on('data', chunk => {
            bufs.push(chunk);
            length += chunk.length;
        });
        res.on('end', () => {
            if (callbackExecuted === true) {
                return;
            }
            callbackExecuted = true;
            var xml = Buffer.concat(bufs, length).toString('utf8');
            _this.homey.app.updateLog('\n_request response (' + _this.hostname + '): ' + _this.homey.app.varToString(xml) + '\n', 3);
            /**
             * Indicates raw xml response from device.
             * @event Cam#rawResponse
             * @type {string} xml received from device
             * @type {number} HTTP statusCode received from device
             */
            _this.emit('rawResponse', xml, statusCode);
            parseSOAPString(xml, callback, statusCode); // xml and statusCode are passed in. Callback is the function called after the XML is parsed
        });
        res.on('error', err => {
            _this.homey.app.updateLog('Res error (' + _this.hostname + ')' + _this.homey.app.varToString(err), 0);
            // if (callbackExecuted === false)
            // {
            //     callbackExecuted = true;
            //     callback(err);
            // }
        });
    }).on('error', err => {
        _this.homey.app.updateLog('Res error (' + _this.hostname + ')' + _this.homey.app.varToString(err), 3);
        // if (callbackExecuted === false)
        // {
        //     callbackExecuted = true;
        //     callback(err);
        // }
    });

    req.setTimeout(reqOptions.timeout, function() {
        req.destroy();
        _this.homey.app.updateLog('Request setTimeout (' + _this.hostname + ')', 0);
    });

    req.on('error', err => {
        _this.homey.app.updateLog('Request error (' + _this.hostname + '): ' + _this.homey.app.varToString(err), 0);
        if (callbackExecuted === false) {
            callbackExecuted = true;
            callback(err, null, null);
        }
    });

    // use its "timeout" event to abort the request
    // req.on('timeout', () => {
    //     _this.homey.app.updateLog('Request timeout (' + _this.hostname + ')', 0);
    //     req.destroy();
    // });

    /**
     * Indicates raw xml request to device.
     * @event Cam#rawRequest
     * @type {Object}
     */
    this.emit('rawRequest', options.body);
    req.write(options.body);
    req.end();
};

/**
 * @callback Cam~DateTimeCallback
 * @property {?Error} error
 * @property {Date} dateTime Date object of current device's dateTime
 * @property {string} xml Raw SOAP response
 */

/**
 * Receive date and time from cam
 * @param {Cam~DateTimeCallback} callback
 */
Cam.prototype.getSystemDateAndTime = function(callback)
{
    // The ONVIF spec says this should work without a Password as we need to know any difference in the
    // remote NVT's time relative to our own time clock (called the timeShift) before we can calculate the
    // correct timestamp in nonce SOAP Authentication header.
    // But.. Panasonic and Digital Barriers both have devices that implement ONVIF that only work with
    // authenticated getSystemDateAndTime. So for these devices we need to do an authenticated getSystemDateAndTime.
    // As 'timeShift' is not set, the local clock MUST be set to the correct time AND the NVT/Camera MUST be set to the correct time
    // if the camera implements Replay Attack Protection (eg Axis)
    this._request({
        // Try the Unauthenticated Request first. Do not use this._envelopeHeader() as we don't have timeShift yet.
        body: '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">' +
            '<s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">' +
            '<GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/>' +
            '</s:Body>' +
            '</s:Envelope>'
    }, function(err, data, xml, statusCode) {
        if (!err){
            try{
                let systemDateAndTime = data[0]['getSystemDateAndTimeResponse'][0]['systemDateAndTime'][0];
                let dateTime = systemDateAndTime['UTCDateTime'] || systemDateAndTime['localDateTime'];
                let time;
                if (dateTime == undefined) {
                    // Seen on a cheap Chinese camera from GWellTimes-IPC. Use the current time.
                    time = new Date();
                } else {
                    let dt = linerase(dateTime[0]);
                    time = new Date(Date.UTC(dt.date.year, dt.date.month - 1, dt.date.day, dt.time.hour, dt.time.minute, dt.time.second));
                }
                if (!this.timeShift){
                    this.timeShift = time - Date.now();
                }
                this.homey.app.updateLog('getSystemDateAndTime (' + this.hostname + '): ' + time.toString() + ', Time Shift: ' + this.timeShift.toString() + ' Finished -----');
                callback.call(this, err, time, xml);
            } catch (err) {
                this.homey.app.updateLog('getSystemDateAndTime (' + this.hostname + '): !err Error ' + err + '\nxml:\n' + xml + '\ndata:\n' + data ? '\ndata:\n' + this.homey.app.varToString(data) : '', 3);
                callback.call(this, err, null, xml);
            }
        }
        if (err) {
            // some cameras return XML with 'sender not authorized'
            // One HikVision camera returned a 401 error code and the following HTML...
            //   <!DOCTYPE html><html><head><title>Document Error: Unauthorized</title></head><body><h2>Access Error: 401 -- Unauthorized</h2>
            //   <p>Authentication Error: Access Denied! Authorization required.</p></body></html>
            if ((xml && (xml.toLowerCase().includes('sender not authorized') || xml.toLowerCase().includes('unauthorized'))) ||
                (statusCode && statusCode === 401)
            ) {
                // Try again with a Username and Password
                this._request({
                    body: this._envelopeHeader() +
                       '<GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/>' +
                       this._envelopeFooter()
                }, function(err, data, xml){
                    try {
                        let systemDateAndTime = data[0]['getSystemDateAndTimeResponse'][0]['systemDateAndTime'][0];
                        let dateTime = systemDateAndTime['UTCDateTime'] || systemDateAndTime['localDateTime'];
                        let time;
                        if (dateTime === undefined) {
                            // Seen on a cheap Chinese camera from GWellTimes-IPC. Use the current time.
                            time = new Date();
                        } else {
                            let dt = linerase(dateTime[0]);
                            time = new Date(Date.UTC(dt.date.year, dt.date.month - 1, dt.date.day, dt.time.hour, dt.time.minute, dt.time.second));
                        }
                        if (!this.timeShift){
                            this.timeShift = time - Date.now();
                        }
                        this.homey.app.updateLog('getSystemDateAndTime (' + this.hostname + '): Finished -----');
                        callback.call(this, err, time, xml);
                    } catch (err) {
                        this.homey.app.updateLog('getSystemDateAndTime (' + this.hostname + '): err err Error ' + err + '\nxml:\n' + xml + '\ndata:\n' + data ? '\ndata:\n' + this.homey.app.varToString(data) : '', 3);
                        callback.call(this, err, null, xml);
                    }
                }.bind(this));
            } else {
                callback(err, null, xml);
            }
        }
    }.bind(this));
};


/**
 * @typedef {object} Cam~SystemDateAndTime
 * @property {string} dayTimeType (Manual | NTP)
 * @property {boolean} daylightSavings
 * @property {string} timezone in POSIX 1003.1 format
 * @property {number} hour
 * @property {number} minute
 * @property {number} second
 * @property {number} year
 * @property {number} month
 * @property {number} day
 */

/**
 * Set the device system date and time
 * @param {object} options
 * @param {Date} [options.dateTime]
 * @param {string} options.dateTimeType (Manual | NTP)
 * @param {boolean} [options.daylightSavings=false]
 * @patam {string} [options.timezone]
 * @param {Cam~DateTimeCallback} callback
 */
Cam.prototype.setSystemDateAndTime = function(options, callback)
{
    if (['Manual', 'NTP'].indexOf(options.dateTimeType) === -1) {
        return callback(new Error('DateTimeType should be `Manual` or `NTP`'));
    }
    this._request({
        body: this._envelopeHeader() +
            '<SetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl">' +
            '<DateTimeType>' +
            options.dateTimeType +
            '</DateTimeType>' +
            '<DaylightSavings>' +
            (!!options.daylightSavings) +
            '</DaylightSavings>' +
            (options.timezone !== undefined ?
                '<TimeZone>' +
                '<TZ xmlns="http://www.onvif.org/ver10/schema">' +
                options.timezone +
                '</TZ>' +
                '</TimeZone>' : '') +
            // ( options.dateTime !== undefined && options.dateTime.getDate instanceof Date ?
            (options.dateTime !== undefined && options.dateTime instanceof Date ?
                '<UTCDateTime>' +
                '<Time xmlns="http://www.onvif.org/ver10/schema">' +
                '<Hour>' + options.dateTime.getUTCHours() + '</Hour>' +
                '<Minute>' + options.dateTime.getUTCMinutes() + '</Minute>' +
                '<Second>' + options.dateTime.getUTCSeconds() + '</Second>' +
                '</Time>' +
                '<Date xmlns="http://www.onvif.org/ver10/schema">' +
                '<Year>' + options.dateTime.getUTCFullYear() + '</Year>' +
                '<Month>' + (options.dateTime.getUTCMonth() + 1) + '</Month>' +
                '<Day>' + options.dateTime.getUTCDate() + '</Day>' +
                '</Date>' +
                '</UTCDateTime>' : '') +
            '</SetSystemDateAndTime>' +
            this._envelopeFooter()
    }, function(err, data, xml) {
        if (err || linerase(data).setSystemDateAndTimeResponse !== '') {
            return callback.call(this, err || (linerase(data).setSystemDateAndTimeResponse !== '') ?
                'Wrong `SetSystemDateAndTime response' :
                err, data, xml);
        }
        //get new system time from device
        this.getSystemDateAndTime(callback);
    }.bind(this));
};

/**
 * Capability list
 * @typedef {object} Cam~Capabilities
 * @property {object} device Device capabilities
 * @property {string} device.XAddr Device service URI
 * @property {object} [device.network] Network capabilities
 * @property {boolean} device.network.IPFilter Indicates support for IP filtering
 * @property {boolean} device.network.zeroConfiguration Indicates support for zeroconf
 * @property {boolean} device.network.IPVersion6 Indicates support for IPv6
 * @property {boolean} device.network.dynDNS Indicates support for dynamic DNS configuration
 * @property {object} [device.system] System capabilities
 * @property {boolean} device.system.discoveryResolve Indicates support for WS Discovery resolve requests
 * @property {boolean} device.system.discoveryBye Indicates support for WS-Discovery Bye
 * @property {boolean} device.system.remoteDiscovery Indicates support for remote discovery
 * @property {boolean} device.system.systemBackup Indicates support for system backup through MTOM
 * @property {boolean} device.system.systemLogging Indicates support for retrieval of system logging through MTOM
 * @property {boolean} device.system.firmwareUpgrade Indicates support for firmware upgrade through MTOM
 * @property {boolean} device.system.httpFirmwareUpgrade Indicates support for firmware upgrade through HTTP
 * @property {boolean} device.system.httpSystemBackup Indicates support for system backup through HTTP
 * @property {boolean} device.system.httpSystemLogging Indicates support for retrieval of system logging through HTTP
 * @property {object} [device.IO] I/O capabilities
 * @property {number} device.IO.inputConnectors Number of input connectors
 * @property {number} device.IO.relayOutputs Number of relay outputs
 * @property {object} [device.IO.extension]
 * @property {boolean} device.IO.extension.auxiliary
 * @property {object} device.IO.extension.auxiliaryCommands
 * @property {object} [device.security] Security capabilities
 * @property {boolean} device.security.'TLS1.1' Indicates support for TLS 1.1
 * @property {boolean} device.security.'TLS1.2' Indicates support for TLS 1.2
 * @property {boolean} device.security.onboardKeyGeneration Indicates support for onboard key generation
 * @property {boolean} device.security.accessPolicyConfig Indicates support for access policy configuration
 * @property {boolean} device.security.'X.509Token' Indicates support for WS-Security X.509 token
 * @property {boolean} device.security.SAMLToken Indicates support for WS-Security SAML token
 * @property {boolean} device.security.kerberosToken Indicates support for WS-Security Kerberos token
 * @property {boolean} device.security.RELToken Indicates support for WS-Security REL token
 * @property {object} events Event capabilities
 * @property {string} events.XAddr Event service URI
 * @property {boolean} events.WSSubscriptionPolicySupport Indicates whether or not WS Subscription policy is supported
 * @property {boolean} events.WSPullPointSupport Indicates whether or not WS Pull Point is supported
 * @property {boolean} events.WSPausableSubscriptionManagerInterfaceSupport Indicates whether or not WS Pausable Subscription Manager Interface is supported
 * @property {object} imaging Imaging capabilities
 * @property {string} imaging.XAddr Imaging service URI
 * @property {object} media Media capabilities
 * @property {string} media.XAddr Media service URI
 * @property {object} media.streamingCapabilities Streaming capabilities
 * @property {boolean} media.streamingCapabilities.RTPMulticast Indicates whether or not RTP multicast is supported
 * @property {boolean} media.streamingCapabilities.RTP_TCP Indicates whether or not RTP over TCP is supported
 * @property {boolean} media.streamingCapabilities.RTP_RTSP_TCP Indicates whether or not RTP/RTSP/TCP is supported
 * @property {object} media.streamingCapabilities.extension
 * @property {object} PTZ PTZ capabilities
 * @property {string} PTZ.XAddr PTZ service URI
 * @property {object} [extension]
 * @property {object} extension.deviceIO DeviceIO capabilities
 * @property {string} extension.deviceIO.XAddr DeviceIO service URI
 * @property {number} extension.deviceIO.videoSources
 * @property {number} extension.deviceIO.videoOutputs
 * @property {number} extension.deviceIO.audioSources
 * @property {number} extension.deviceIO.audioOutputs
 * @property {number} extension.deviceIO.relayOutputs
 * @property {object} [extension.extensions]
 * @property {object} [extension.extensions.telexCapabilities]
 * @property {object} [extension.extensions.scdlCapabilities]
 */

/**
 * @callback Cam~GetCapabilitiesCallback
 * @property {?Error} error
 * @property {Cam~Capabilities} capabilities
 * @property {string} xml Raw SOAP response
 */

/**
 * This method has been replaced by the more generic GetServices method. For capabilities of individual services refer to the GetServiceCapabilities methods.
 * @param {Cam~GetCapabilitiesCallback} [callback]
 */
Cam.prototype.getCapabilities = function(callback) {
    this.homey.app.updateLog('getCapabilities (' + this.hostname + '): Started *****');

    this._request({
        body: this._envelopeHeader() +
            '<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl">' +
            '<Category>All</Category>' +
            '</GetCapabilities>' +
            this._envelopeFooter()
    }, function(err, data, xml) {
        if (!err) {
            /**
             * Device capabilities
             * @name Cam#capabilities
             * @type {Cam~Capabilities}
             */
            this.capabilities = linerase(data[0]['getCapabilitiesResponse'][0]['capabilities'][0]);
            // fill Cam#uri property
            if (!this.uri) {
                /**
                 * Device service URIs
                 * @name Cam#uri
                 * @property {url} [PTZ]
                 * @property {url} [media]
                 * @property {url} [imaging]
                 * @property {url} [events]
                 * @property {url} [device]
                 */
                this.uri = {};
            }
            ['PTZ', 'media', 'imaging', 'events', 'device'].forEach(function(name) {
                if (this.capabilities[name] && this.capabilities[name].XAddr) {
                    this.uri[name.toLowerCase()] = this._parseUrl(this.capabilities[name].XAddr);
                }
            }.bind(this));
            // extensions, eg. deviceIO
            if (this.capabilities.extension) {
                Object.keys(this.capabilities.extension).forEach(function(ext) {
                    // TODO think about complex extensions like `telexCapabilities` and `scdlCapabilities`
                    if (this.capabilities.extension[ext].XAddr) {
                        this.uri[ext] = url.parse(this.capabilities.extension[ext].XAddr);
                    }
                }.bind(this));
            }
            // HACK for a Profile G NVR that has 'replay' but did not have 'recording' in GetCapabilities
            if ((this.uri['replay']) && !this.uri['recording']) {
                var tempRecorderXaddr = this.uri['replay'].href.replace('replay', 'recording');
                console.warn('WARNING: Adding ' + tempRecorderXaddr + ' for bad Profile G device');
                this.uri['recording'] = url.parse(tempRecorderXaddr);
            }
            this.homey.app.updateLog('getCapabilities (' + this.hostname + '): Finished -----');
        }
        if (callback) {
            callback.call(this, err, this.capabilities, xml);
        }
    }.bind(this));
};

/**
 * Returns the capabilities of the device service
 * @param [callback]
 */
Cam.prototype.getServiceCapabilities = function(callback) {
    this._request({
        body: this._envelopeHeader() +
            '<GetServiceCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl" />' +
            this._envelopeFooter()
    }, function(err, data, xml) {
        if (!err) {
            data = linerase(data);
            this.serviceCapabilities = {
                network: data.getServiceCapabilitiesResponse.capabilities.network ? data.getServiceCapabilitiesResponse.capabilities.network.$ : null,
                security: data.getServiceCapabilitiesResponse.capabilities.security ? data.getServiceCapabilitiesResponse.capabilities.security.$ : null,
                system: data.getServiceCapabilitiesResponse.capabilities.system ? data.getServiceCapabilitiesResponse.capabilities.system.$ : null
            };
            if (data.getServiceCapabilitiesResponse.capabilities.misc) {
                this.serviceCapabilities.auxiliaryCommands = data.getServiceCapabilitiesResponse.capabilities.misc.$.AuxiliaryCommands.split(' ');
            }
        }
        if (callback) {
            callback.call(this, err, this.serviceCapabilities, xml);
        }
    }.bind(this));
};

/**
 * Active source
 * @typedef {object} Cam~ActiveSource
 * @property {string} sourceToken video source token
 * @property {string} profileToken profile token
 * @property {string} videoSourceConfigurationToken video source configuration token
 * @property {object} [ptz] PTZ-object
 * @property {string} ptz.name PTZ configuration name
 * @property {string} ptz.token PTZ token
 */

/**
 * Get active sources
 * @private
 */
Cam.prototype.getActiveSources = function() {
    //NVT is a camera with one video source
    if (this.videoSources.$) {
        this.videoSources = [this.videoSources];
    }

    //The following code block supports a camera with a single video source
    //as well as encoders with multiple sources. By default, the first source is set to the activeSource.
    /**
     * Default profiles for the device
     * @name Cam#defaultProfiles
     * @type {Array.<Cam~Profile>}
     */
    this.defaultProfiles = [];
    /**
     * Active video sources
     * @name Cam#activeSources
     * @type {Array.<Cam~ActiveSource>}
     */
    this.activeSources = [];
    this.homey.app.updateLog('VideoSources (' + this.hostname + '): ' + this.homey.app.varToString(this.videoSources));

    this.videoSources.forEach(function(videoSource, idx) {
        // let's choose first appropriate profile for our video source and make it default
        var videoSrcToken = videoSource.$.token,
            appropriateProfiles = this.profiles.filter(function(profile) {
                return (profile.videoSourceConfiguration ?
                    profile.videoSourceConfiguration.sourceToken === videoSrcToken :
                    false) && (profile.videoEncoderConfiguration);
            });
        if (appropriateProfiles.length === 0) {
            if (idx === 0) {
                this.homey.app.updateLog('getActiveSources (' + this.hostname + '): Unrecognized configuration form ' + this.homey.app.varToString(this.profiles));
                throw new Error('Unrecognized configuration');
            } else {
                return null;
            }
        }

        if (idx === 0) {
            /**
             * Default selected profile for the device
             * @name Cam#defaultProfile
             * @type {Cam~Profile}
             */
            this.defaultProfile = appropriateProfiles[0];
        }

        this.defaultProfiles[idx] = appropriateProfiles[0];

        this.homey.app.updateLog('ActiveSource (' + this.hostname + ') [' + idx + '] = ' + this.homey.app.varToString(this.defaultProfiles[idx].videoEncoderConfiguration));
        this.homey.app.updateLog('VideoSource (' + this.hostname + ') [' + idx + '] = ' + this.homey.app.varToString(videoSource));
        this.activeSources[idx] = {
            sourceToken: videoSource.$.token,
            profileToken: this.defaultProfiles[idx].$.token,
            videoSourceConfigurationToken: this.defaultProfiles[idx].videoSourceConfiguration.$.token
        };
        if (this.defaultProfiles[idx].videoEncoderConfiguration) {
            var configuration = this.defaultProfiles[idx].videoEncoderConfiguration;
            this.activeSources[idx].encoding = configuration.encoding;
            this.activeSources[idx].width = configuration.resolution ? configuration.resolution.width : '';
            this.activeSources[idx].height = configuration.resolution ? configuration.resolution.height : '';
            this.activeSources[idx].fps = configuration.rateControl ? configuration.rateControl.frameRateLimit : '';
            this.activeSources[idx].bitrate = configuration.rateControl ? configuration.rateControl.bitrateLimit : '';
        }

        if (idx === 0) {
            /**
             * Current active video source
             * @name Cam#activeSource
             * @type {Cam~ActiveSource}
             */
            this.activeSource = this.activeSources[idx];
        }

        if (this.defaultProfiles[idx].PTZConfiguration) {
            this.activeSources[idx].ptz = {
                name: this.defaultProfiles[idx].PTZConfiguration.name,
                token: this.defaultProfiles[idx].PTZConfiguration.$.token
            };
            /*
            TODO Think about it
            if (idx === 0) {
                this.defaultProfile.PTZConfiguration = this.activeSources[idx].PTZConfiguration;
            }*/

            return this.activeSource;
        }
    }.bind(this));

    // If we haven't got any active source, send a warning
    if (this.activeSources.length === 0) {
        /**
         * Indicates any warning.
         * @event Cam#warning
         * @type {string}
         */
        this.homey.app.updateLog('getActiveSources (' + this.hostname + '): There are no active sources at this device');
        this.emit('warning', 'There are no active sources at this device');
    }

    return this.activeSource;
};

Cam.prototype.setActiveSource = function(idx) {
    if (this.activeSources.length <= idx) {
        this.homey.app.updateLog('setActiveSource (' + this.hostname + '): Invalid source for this device');
        this.emit('warning', 'Invalid source for this device');
        return;
    }

    this.activeSource = this.activeSources[idx];
};

/**
 * @typedef {object} Cam~Service
 * @property {string} namespace Namespace uri
 * @property {string} XAddr Uri for requests
 * @property {number} version.minor Minor version
 * @property {number} version.major Major version
 */

/**
 * @callback Cam~GetServicesCallback
 * @property {?Error} error
 * @property {Array.<Cam~Service>} services
 * @property {string} xml Raw SOAP response
 */

/**
 * Returns information about services on the device.
 * @param {boolean} [includeCapability=true] Indicates if the service capabilities (untyped) should be included in the response.
 * @param {Cam~GetServicesCallback} [callback]
 */
Cam.prototype.getServices = function(includeCapability, callback) {
    this.homey.app.updateLog('getServices (' + this.hostname + '): Started *****');

    if (typeof includeCapability == 'function') {
        callback = includeCapability;
        includeCapability = true;
    }
    this._request({
        body: this._envelopeHeader() +
            '<GetServices xmlns="http://www.onvif.org/ver10/device/wsdl">' +
            '<IncludeCapability>' + includeCapability + '</IncludeCapability>' +
            '</GetServices>' +
            this._envelopeFooter(),
    }, function(err, data, xml) {
        if (!err) {
            /**
             * Device services
             * @name Cam#services
             * @type {Cam~Services}
             */
            this.homey.app.updateLog('getServices (' + this.hostname + '): ' + this.homey.app.varToString(data), 3);
            this.services = linerase(data).getServicesResponse.service;

            // ONVIF Profile T introduced Media2 (ver20) so cameras from around 2020/2021 will have
            // two media entries in the ServicesResponse, one for Media (ver10/media) and one for Media2 (ver20/media)
            // This is so that existing VMS software can still access the video via the orignal ONVIF Media API
            // fill Cam#uri property
            if (!this.uri) {
                /**
                 * Device service URIs
                 * @name Cam#uri
                 * @property {url} [PTZ]
                 * @property {url} [media]
                 * @property {url} [media2]
                 * @property {url} [imaging]
                 * @property {url} [events]
                 * @property {url} [device]
                 */
                this.uri = {};
            }
            this.media2Support = false;
            this.services.forEach((service) => {
                // Look for services with namespaces and XAddr values
                if (Object.prototype.hasOwnProperty.call(service, 'namespace') && Object.prototype.hasOwnProperty.call(service, 'XAddr')) {
                    // Only parse ONVIF namespaces. Axis cameras return Axis namespaces in GetServices
                    let parsedNamespace = url.parse(service.namespace);
                    if (parsedNamespace.hostname === 'www.onvif.org') {
                        let namespaceSplitted = parsedNamespace.path.substring(1).split('/'); // remove leading Slash, then split
                        // special case for Media and Media2 where cameras supporting Profile S and Profile T (2020/2021 models) have two media services
                        // if (namespaceSplitted[1] == 'media' && namespaceSplitted[0] == 'ver20') {
                        //     this.media2Support = true;
                        //     namespaceSplitted[1] = 'media2';
                        // }
                        this.uri[namespaceSplitted[1]] = this._parseUrl(service.XAddr);
                    } else {
                        this.homey.app.updateLog('getServices (' + this.hostname + '): Unrecognised namespace for service ' + service);
                    }
                } else {
                    this.homey.app.updateLog('getServices (' + this.hostname + '): Missing namespace for service ' + service);
                }
            });
            this.homey.app.updateLog('getServices (' + this.hostname + '): Finished -----');
        }
        if (callback) {
            callback.call(this, err, this.services, xml);
        }
    }.bind(this));
};

/**
 * @typedef {object} Cam~DeviceInformation
 * @property {string} manufacturer The manufactor of the device
 * @property {string} model The device model
 * @property {string} firmwareVersion The firmware version in the device
 * @property {string} serialNumber The serial number of the device
 * @property {string} hardwareId The hardware ID of the device
 */

/**
 * @callback Cam~GetDeviceInformationCallback
 * @property {?Error} error
 * @property {Cam~DeviceInformation} deviceInformation Device information
 * @property {string} xml Raw SOAP response
 */

/**
 * Receive device information
 * @param {Cam~GetDeviceInformationCallback} [callback]
 */
Cam.prototype.getDeviceInformation = function(callback) {
    this._request({
        body: this._envelopeHeader() +
            '<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>' +
            this._envelopeFooter()
    }, function(err, data, xml) {
        if (!err) {
            this.deviceInformation = linerase(data).getDeviceInformationResponse;
        }
        if (callback) {
            callback.call(this, err, this.deviceInformation, xml);
        }
    }.bind(this));
};

/**
 * @typedef {object} Cam~HostnameInformation
 * @property {boolean} fromDHCP Indicates whether the hostname is obtained from DHCP or not
 * @property {string} [name] Indicates the hostname
 */

/**
 * @callback Cam~GetHostnameCallback
 * @property {?Error} error
 * @property {Cam~HostnameInformation} hostnameInformation Hostname information
 * @property {string} xml Raw SOAP response
 */

/**
 * Receive hostname information
 * @param {Cam~GetHostnameCallback} [callback]
 */
Cam.prototype.getHostname = function(callback){
    this._request({
        body: this._envelopeHeader() +
            '<GetHostname xmlns="http://www.onvif.org/ver10/device/wsdl"/>' +
            this._envelopeFooter()
    }, function(err, data, xml) {
        if (callback) {
            callback.call(this, err, err ? null : linerase(data).getHostnameResponse.hostnameInformation, xml);
        }
    }.bind(this));
};

/**
 * @typedef {object} Cam~Scope
 * @property {string} scopeDef Indicates if the scope is fixed or configurable
 * @property {string} scopeItem Scope item URI
 */

/**
 * @callback Cam~getScopesCallback
 * @property {?Error} error
 * @property {Array<Cam~Scope>} scopes Scopes
 * @property {string} xml Raw SOAP response
 */

/**
 * Receive the scope parameters of a device
 * @param {Cam~getScopesCallback} callback
 */
Cam.prototype.getScopes = function(callback) {
    this._request({
        body: this._envelopeHeader() +
            '<GetScopes xmlns="http://www.onvif.org/ver10/device/wsdl"/>' +
            this._envelopeFooter()
    }, function(err, data, xml) {
        if (!err) {
            /**
             * Device scopes
             * @type {undefined|Array<Cam~Scope>}
             */
            this.scopes = linerase(data).getScopesResponse.scopes;
            if (this.scopes === undefined) {
                this.scopes = [];
            } else if (!Array.isArray(this.scopes)) {
                this.scopes = [this.scopes];
            }
        }
        if (callback) {
            callback.call(this, err, this.scopes, xml);
        }
    }.bind(this));
};

/**
 * Set the scope parameters of a device
 * @param {Array<string>} scopes array of scope's uris
 * @param {Cam~getScopesCallback} callback
 */
Cam.prototype.setScopes = function(scopes, callback) {
    this._request({
        body: this._envelopeHeader() +
            '<SetScopes xmlns="http://www.onvif.org/ver10/device/wsdl">' +
            scopes.map(function(uri) { return '<Scopes>' + uri + '</Scopes>'; }).join('') +
            '</SetScopes>' +
            this._envelopeFooter()
    }, function(err, data, xml) {
        if (err || linerase(data).setScopesResponse !== '') {
            return callback(linerase(data).setScopesResponse !== '' ? new Error('Wrong `SetScopes` response') : err, data, xml);
        }
        // get new scopes from device
        this.getScopes(callback);
    }.bind(this));
};

/**
 * /Device/ Reboot the device
 * @param {Cam~MessageCallback} callback
 */
Cam.prototype.systemReboot = function(callback) {
    this._request({
        service: 'deviceIO',
        body: this._envelopeHeader() +
            '<SystemReboot xmlns="http://www.onvif.org/ver10/device/wsdl"/>' +
            this._envelopeFooter()
    }, function(err, res, xml) {
        if (!err) {
            res = res[0].systemRebootResponse[0].message[0];
        }
        callback.call(this, err, res, xml);
    });
};

/**
 * @callback Cam~SetSystemFactoryDefaultCallback
 * @property {?Error} error
 * @property {null}
 * @property {string} xml Raw SOAP response
 */

/**
 * Reset camera to factory default
 * @param {boolean} [hard=false] Reset network settings
 * @param {Cam~SetSystemFactoryDefaultCallback} callback
 */
Cam.prototype.setSystemFactoryDefault = function(hard, callback) {
    if (callback === undefined) {
        callback = hard;
        hard = false;
    }
    let body = this._envelopeHeader() +
        '<SetSystemFactoryDefault xmlns="http://www.onvif.org/ver10/device/wsdl">' +
        '<FactoryDefault>' + (hard ? 'Hard' : 'Soft') + '</FactoryDefault>' +
        '</SetSystemFactoryDefault>' +
        this._envelopeFooter();
    this._request({
        service: 'device',
        body: body,
    }, function(err, res, xml) {
        if (callback) {
            callback.call(this, err, null, xml);
        }
    });
};

/**
 * Generate arguments for digest auth
 * @return {{passdigest: *, nonce: (*|String), timestamp: string}}
 * @private
 */
Cam.prototype._passwordDigest = function() {
    let timestamp = (new Date(Date.now() + (this.timeShift || 0))).toISOString();
    let nonce = Buffer.allocUnsafe(16);
    nonce.writeUIntLE(Math.ceil(Math.random() * 0x100000000), 0, 4);
    nonce.writeUIntLE(Math.ceil(Math.random() * 0x100000000), 4, 4);
    nonce.writeUIntLE(Math.ceil(Math.random() * 0x100000000), 8, 4);
    nonce.writeUIntLE(Math.ceil(Math.random() * 0x100000000), 12, 4);
    let cryptoDigest = crypto.createHash('sha1');
    cryptoDigest.update(Buffer.concat([nonce, Buffer.from(timestamp, 'ascii'), Buffer.from(this.password, 'ascii')]));
    let passdigest = cryptoDigest.digest('base64');
    return {
        passdigest: passdigest,
        nonce: nonce.toString('base64'),
        timestamp: timestamp
    };
};

/**
 * Envelope header for all SOAP messages
 * @property {boolean} [openHeader=false]
 * @returns {string}
 * @private
 */
Cam.prototype._envelopeHeader = function(openHeader) {
    var header = '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://www.w3.org/2005/08/addressing">' +
        '<s:Header>' +
        '<a:MessageID> urn:uuid:' + guid() + '</a:MessageID>';

    // Only insert Security if there is a username and password
    if (this.username && this.password) {
        var req = this._passwordDigest();
        header += '<Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">' +
            '<UsernameToken>' +
            '<Username>' + this.username + '</Username>' +
            '<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">' + req.passdigest + '</Password>' +
            '<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">' + req.nonce + '</Nonce>' +
            '<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">' + req.timestamp + '</Created>' +
            '</UsernameToken>' +
            '</Security>';
    }
    if (!(openHeader !== undefined && openHeader)) {
        header += '</s:Header>' +
            '<s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">';
    }
    return header;
};

/**
 * Envelope footer for all SOAP messages
 * @returns {string}
 * @private
 */
Cam.prototype._envelopeFooter = function() {
    return '</s:Body>' +
        '</s:Envelope>';
};

/**
 * Parse url with an eye on `preserveAddress` property
 * @param {string} address
 * @returns {Url}
 * @private
 */
Cam.prototype._parseUrl = function(address) {
    const parsedAddress = url.parse(address);
    // If host for service and default host differs, also if preserve address property set
    // we substitute host, hostname and port from settings then rebuild the href using .format
    if (this.preserveAddress && this.hostname !== parsedAddress.hostname) {
        parsedAddress.hostname = this.hostname;
        parsedAddress.host = this.hostname + ':' + this.port;
        parsedAddress.port = this.port;
        parsedAddress.href = url.format(parsedAddress);
    }
    return parsedAddress;
};

module.exports = {
    Cam: Cam
};

// extending Camera prototype
require('./device')(Cam);
require('./events')(Cam);
require('./media')(Cam);
require('./ptz')(Cam);
require('./imaging')(Cam);
require('./recording')(Cam);
require('./replay')(Cam);