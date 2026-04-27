/**
 * @namespace utils
 * @description Common utils module
 * @author Andrew D.Laptev <a.d.laptev@gmail.com>
 * @licence MIT
 */

const xml2js = require('../../xml2js'),
    numberRE = /^-?([1-9]\d*|0)(\.\d*)?$/,
    dateRE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(.\d+)?Z$/,
    prefixMatch = /(?!xmlns)^.*:/;

const SOAP_FAULT_HINTS = {
    sender: 'Request rejected by camera. Check username/password, user permissions, or unsupported request parameters.',
    receiver: 'Camera failed while processing a valid request. This is usually a device-side issue.',
    mustunderstand: 'Camera did not understand a required SOAP header.',
    versionmismatch: 'SOAP version mismatch between client and camera.',
    dataencodingunknown: 'Camera could not decode the SOAP payload encoding.'
};

function getSoapFaultHint(faultCode) {
    if (!faultCode) {
        return '';
    }

    const normalizedCode = String(faultCode).toLowerCase();
    const codeSuffix = normalizedCode.split(':').pop();

    return SOAP_FAULT_HINTS[codeSuffix] || '';
}

/**
 * Parse SOAP object to pretty JS-object
 * @param {object} xml
 * @returns {object}
 */
const linerase = function(xml) {
    if (Array.isArray(xml)) {
        if (xml.length > 1) {
            return xml.map(linerase);
        } else {
            xml = xml[0];
        }
    }
    if (typeof xml === 'object') {
        var obj = {};
        Object.keys(xml).forEach(function(key) {
            obj[key] = linerase(xml[key]);
        });
        return obj;
    } else {
        if (xml === 'true') { return true; }
        if (xml === 'false') { return false; }
        if (numberRE.test(xml)) { return parseFloat(xml); }
        if (dateRE.test(xml)) { return new Date(xml); }
        return xml;
    }
};

/**
 * @callback ParseSOAPStringCallback
 * @property {?Error} error
 * @property {object} SOAP response
 * @property {string} raw XML
 * @property {number} HTTP Status Code
 */

/**
 * Parse SOAP response
 * @param {string} xmlOrigin
 * @param {ParseSOAPStringCallback} callback
 * @param {number} statusCode. This is passed in so it can be passed back out to the callback
 */
const parseSOAPString = function(xmlOrigin, callback, statusCode) {
    /* Filter out xml name spaces */
    var xml = xmlOrigin.replace(/xmlns([^=]*?)=(".*?")/g,'');

    try {
        xml2js.parseString(
            xml,
            {
                tagNameProcessors: [function(str) {
                    str = str.replace(prefixMatch, '');
                    var secondLetter = str.charAt(1);
                    if (secondLetter && secondLetter.toUpperCase() !== secondLetter) {
                        return str.charAt(0).toLowerCase() + str.slice(1);
                    } else {
                        return str;
                    }
                }]
            },
            function(err, result) {
                if (!result || !result['envelope'] || !result['envelope']['body']) {
					if (statusCode === 404) {
						return callback(new Error('ONVIF item not found'), null, xml, statusCode);
					}
                    callback(new Error('Wrong ONVIF SOAP response'), null, xml, statusCode);
                } else {
                    if (!err && result['envelope']['body'][0]['fault']) {
                        var fault = result['envelope']['body'][0]['fault'][0];
                        var reason = '';
                        var faultCode = '';
                        try {
                            if (fault.reason[0].text[0]._) {
                                reason = fault.reason[0].text[0]._;
                            }
                        } catch (e) {
                            reason = '';
                        }

                        if (!reason) {
                            try {
                                if (fault.reason[0].text[0]) {
                                    reason = String(fault.reason[0].text[0]);
                                }
                            } catch (e) {
                                reason = '';
                            }
                        }

                        try {
                            faultCode = linerase(fault.code[0]);
                            if (faultCode && faultCode.value) {
                                faultCode = String(faultCode.value);
                            } else if (faultCode) {
                                faultCode = String(faultCode);
                            } else {
                                faultCode = '';
                            }
                        } catch (e) {
                            faultCode = '';
                        }

                        if (!reason) {
                            try {
                                reason = faultCode || '';
                            } catch (e) {
                                reason = '';
                            }
                        }

                        var detail = '';
                        try {
                            if (fault.detail)
                            {
                                detail = linerase(fault.detail[0]);
                                if (typeof detail === 'object') {
                                    detail = JSON.stringify(detail);
                                } else {
                                    detail = String(detail);
                                }
                            }
                        } catch (e) {
                            detail = '';
                        }

                        // Always return an Error object for SOAP faults.
                        var faultMessage = 'ONVIF SOAP Fault';
                        if (faultCode) {
                            faultMessage += ' [' + faultCode + ']';
                        }
                        if (reason) {
                            faultMessage += ' ' + reason;
                        }
                        if (detail) {
                            faultMessage += ': ' + detail;
                        }

                        var faultHint = getSoapFaultHint(faultCode);
                        if (faultHint) {
                            faultMessage += ' (' + faultHint + ')';
                        }

                        err = new Error(faultMessage);
                    }
                    callback(err, result['envelope']['body'], xml, statusCode);
                }
            }
        );
    } catch (err) {
        callback(err, '', xml, statusCode);
    }
};

const s4 = function() {
    return (((1 + Math.random()) * 0x10000) | 0).toString(16).substring(1);
};

/**
 * Generate GUID
 * @returns {string}
 */
const guid = function() {
    return (s4() + s4() + '-' + s4() + '-' + s4() + '-' + s4() + '-' + s4() + s4() + s4());
};

module.exports = {
    linerase: linerase,
    parseSOAPString: parseSOAPString,
    guid: guid
};
