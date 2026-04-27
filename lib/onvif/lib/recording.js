/**
 * @namespace cam
 * @description Recording section for Cam class
 * @author Roger Hardiman <opensource@rjh.org.uk>
 * @licence MIT
 */
module.exports = function(Cam) {

    const linerase = require('./utils').linerase;

    function callbackMissingOption(context, callback, optionName) {
        if (callback) {
            callback.call(context, new Error('Missing required option: ' + optionName), null, null);
        }
    }

    /**
	 * @typedef {object} Cam~RecordingItem
	 * @property {string} $.token Recording token
	 * @property {string} configuration.source.sourceid
	 * @property {string} configuration.content
	 * @property {string} configuration.maximumretentiontime
	 * @property {string} tracks.track.tracktoken
	 * @property {string} tracks.configuration.tracktype
	 * @property {string} tracks.configuration.description
	 */

    /**
	 * @callback Cam~GetRecordingsCallback
	 * @property {?Error} error
	 * @property {Cam~RecordingItem|Array.<Cam~RecordingItem>} recording items
	 * @property {string} xml Raw SOAP response
	 */

    /**
	 * Get Recording Items (links Video Sources to Recording Tracks)
	 * @param {Cam~GetRecordingsCallback} [callback]
	 */
    Cam.prototype.getRecordings = function(callback) {
        this._request({
            service: 'recording'
            , body: this._envelopeHeader() +
			'<GetRecordings xmlns="http://www.onvif.org/ver10/recording/wsdl"/>' +
			this._envelopeFooter()
        }, function(err, data, xml) {
            if (!err) {
                /**
				 * Recording Item
				 * @name Cam#recordingItem
				 * @type {Cam~RecordingItem|Array.<Cam~RecordingItem>}
				 */
                this.recordingItems = linerase(data).getRecordingsResponse.recordingItem;
            }
            if (callback) {
                callback.call(this, err, this.recordingItems, xml);
            }
        }.bind(this));
    };

    /**
	 * Get Recording Job Items
	 * @param {Cam~GetRecordingsCallback} [callback]
	 */
    Cam.prototype.getRecordingJobs = function(callback) {
        this._request({
            service: 'recording'
            , body: this._envelopeHeader() +
				'<GetRecordingJobs xmlns="http://www.onvif.org/ver10/recording/wsdl"/>' +
				this._envelopeFooter()
        }, function(err, data, xml) {
            if (!err) {
                /**
				 * Recording Job Items
				 * @name Cam#recordingJobItems
				 * @type {Cam~RecordingJobItem|Array.<Cam~RecordingJobItem>}
				 */
                this.jobItem = linerase(data).getRecordingJobsResponse.jobItem;
            }
            if (callback) {
                callback.call(this, err, this.jobItem, xml);
            }
        }.bind(this));
    };

    /**
	 * @param {Object} options
	 * @param {String} [options.scheduleToken]
	 * @param {String} [options.recordingToken]
	 * @param {String} [options.mode]
	 * @param {Number} [options.priority]
	 * @param {String} [options.source.sourceToken.type]
	 * @param {String} [options.source.sourceToken.token]
	 * @param {Boolean} [options.source.autoCreateReceiver]
	 * @param {String} [options.source.tracks.sourceTag]
	 * @param {String} [options.source.extension]
	 * @param {Object} [options.extension]
	 * @param {Cam~GetRecordingsCallback} [callback]
	 */
    Cam.prototype.createRecordingJob = function(options, callback) {
        options = options || {};
        const source = options.source || {};
        const sourceToken = source.sourceToken || {};
        const tracks = source.tracks || {};

        if (!options.recordingToken) {
            if (callback) {
                callback.call(this, new Error('Missing required option: recordingToken'), null, null);
            }
            return;
        }

        const commandSend = '<CreateRecordingJob xmlns="http://www.onvif.org/ver10/recording/wsdl">' +
				'<JobConfiguration>' +
				'<ScheduleToken>' + (options.scheduleToken || '') + '</ScheduleToken>' +
				'<RecordingToken>' + (options.recordingToken || '') + '</RecordingToken>' +
				'<Mode>' + (options.mode || '') + '</Mode>' +
				'<Priority>' + (options.priority || '') + '</Priority>' +
				'<Source>' +
				'<SourceToken>' +
                '<Type>' + (sourceToken.type || '') + '</Type>' +
                '<Token>' + (sourceToken.token || '') + '</Token>' +
				'</SourceToken>' +
                '<AutoCreateReceiver>' + (source.autoCreateReceiver || '') + '</AutoCreateReceiver>' +
				'<Tracks>' +
                '<SourceTag>' + (tracks.sourceTag || '') + '</SourceTag>' +
                '<Destination>' + (tracks.destination || '') + '</Destination>' +
				'</Tracks>' +
                '<Extension>' + (source.extension || '') + '</Extension>' +
				'</Source>' +
				'<Extension>' + (options.extension || '') + '</Extension>' +
				'</JobConfiguration>' +
				'</CreateRecordingJob>';
        this._request({
            service: 'recording'
            , body: this._envelopeHeader() + commandSend +
				this._envelopeFooter()
        }, function(err, data, xml) {
            if (!err) {
                this.recordingJob = linerase(data).createRecordingJobResponse;
            }
            if (callback) {
                callback.call(this, err, this.recordingJob, xml);
            }
        }.bind(this));
    };

    Cam.prototype.getRecordingSummary = function(callback) {
        this._request({
            service: 'search',
            body: this._envelopeHeader() +
				'<GetRecordingSummary xmlns="http://www.onvif.org/ver10/search/wsdl"/>' +
				this._envelopeFooter()
        }, function(err, data, xml) {
            if (!err) {
                this.recordingSummary = linerase(data).getRecordingSummaryResponse.summary;
            }
            if (callback) {
                callback.call(this, err, this.recordingSummary, xml);
            }
        }.bind(this));
    };

    Cam.prototype.getRecordingInformation = function(options, callback) {
        options = options || {};
        const recordingToken = options.RecordingToken || options.recordingToken;
        if (!recordingToken) {
            callbackMissingOption(this, callback, 'RecordingToken');
            return;
        }
        this._request({
            service: 'search',
            body: this._envelopeHeader() +
				'<GetRecordingInformation xmlns="http://www.onvif.org/ver10/search/wsdl">' +
				'<RecordingToken>' + recordingToken + '</RecordingToken>' +
				'</GetRecordingInformation>' +
				this._envelopeFooter()
        }, function(err, data, xml) {
            if (!err) {
                this.summary = linerase(data).getRecordingSummaryResponse.summary;
            }
            if (callback) {
                callback.call(this, err, this.summary, xml);
            }
        }.bind(this));
    };

    Cam.prototype.getRecordingConfiguration = function(options, callback) {
        options = options || {};
        const recordingToken = options.RecordingToken || options.recordingToken;
        if (!recordingToken) {
            callbackMissingOption(this, callback, 'RecordingToken');
            return;
        }
        this._request({
            service: 'recording',
            body: this._envelopeHeader() +
				'<GetRecordingConfiguration xmlns="http://www.onvif.org/ver10/recording/wsdl">' +
				'<RecordingToken>' + recordingToken + '</RecordingToken>' +
				'</GetRecordingConfiguration>' +
				this._envelopeFooter()
        }, function(err, data, xml) {
            if (!err) {
                this.recordingConfiguration = linerase(data).getRecordingConfigurationResponse.recordingConfiguration;
            }
            if (callback) {
                callback.call(this, err, this.recordingConfiguration, xml);
            }
        }.bind(this));
    };

    Cam.prototype.getRecordingJobState = function(options, callback) {
        options = options || {};
        const jobToken = options.JobToken || options.jobToken;
        if (!jobToken) {
            callbackMissingOption(this, callback, 'JobToken');
            return;
        }
        this._request({
            service: 'recording',
            body: this._envelopeHeader() +
				'<GetRecordingJobState xmlns="http://www.onvif.org/ver10/recording/wsdl">' +
				'<JobToken>' + jobToken + '</JobToken>' +
				'</GetRecordingJobState>' +
				this._envelopeFooter()
        }, function(err, data, xml) {
            if (!err) {
                this.recordingJobState = linerase(data).getRecordingJobStateResponse.state;
            }
            if (callback) {
                callback.call(this, err, this.recordingJobState, xml);
            }
        }.bind(this));
    };

    Cam.prototype.deleteRecordingJob = function(options, callback) {
        options = options || {};
        const jobToken = options.JobToken || options.jobToken;
        if (!jobToken) {
            callbackMissingOption(this, callback, 'JobToken');
            return;
        }
        this._request({
            service: 'recording',
            body: this._envelopeHeader() +
				'<DeleteRecordingJob xmlns="http://www.onvif.org/ver10/recording/wsdl">' +
				'<JobToken>' + jobToken + '</JobToken>' +
				'</DeleteRecordingJob>' +
				this._envelopeFooter()
        }, function(err, data, xml) {
            let deleteRecordingJobResponse = {};
            if (!err) {
                deleteRecordingJobResponse = linerase(data).deleteRecordingJobResponse;
            }
            if (callback) {
                callback.call(this, err, deleteRecordingJobResponse, xml);
            }
        }.bind(this));
    };

    Cam.prototype.getRecordingOptions = function(options, callback) {
        options = options || {};
        const recordingToken = options.RecordingToken || options.recordingToken;
        if (!recordingToken) {
            callbackMissingOption(this, callback, 'RecordingToken');
            return;
        }
        this._request({
            service: 'recording',
            body: this._envelopeHeader() +
				'<GetRecordingOptions xmlns="http://www.onvif.org/ver10/recording/wsdl">' +
				'<RecordingToken>' + recordingToken + '</RecordingToken>' +
				'</GetRecordingOptions>' +
				this._envelopeFooter()
        }, function(err, data, xml) {
            if (!err) {
                this.recordingOptions = linerase(data).getRecordingOptionsResponse.options;
            }
            if (callback) {
                callback.call(this, err, this.recordingOptions, xml);
            }
        }.bind(this));
    };


    Cam.prototype.getRecordingServiceCapabilities = function(callback) {
        this._request({
            service: 'recording',
            body: this._envelopeHeader() +
				'<GetServiceCapabilities xmlns="http://www.onvif.org/ver10/recording/wsdl"/>' +
				this._envelopeFooter()
        }, function(err, data, xml) {
            if (!err) {
                this.searchCapabilities = linerase(data).getServiceCapabilitiesResponse.capabilities;
            }
            if (callback) {
                callback.call(this, err, this.searchCapabilities, xml);
            }
        }.bind(this));
    };
    Cam.prototype.getTrackConfiguration = function(options, callback) {
        options = options || {};
        const recordingToken = options.recordingToken || options.RecordingToken;
        const trackToken = options.trackToken || options.TrackToken;
        if (!recordingToken) {
            callbackMissingOption(this, callback, 'recordingToken');
            return;
        }
        if (!trackToken) {
            callbackMissingOption(this, callback, 'trackToken');
            return;
        }
        this._request({
            service: 'recording',
            body: this._envelopeHeader() +
				'<GetTrackConfiguration xmlns="http://www.onvif.org/ver10/recording/wsdl">' +
				'<RecordingToken>' + recordingToken + '</RecordingToken>' +
				'<TrackToken>' + trackToken + '</TrackToken>' +
				'</GetTrackConfiguration>' +
				this._envelopeFooter()
        }, function(err, data, xml) {
            if (!err) {
                this.trackConfiguration = linerase(data).getTrackConfigurationResponse.trackConfiguration;
            }
            if (callback) {
                callback.call(this, err, this.trackConfiguration, xml);
            }
        }.bind(this));
    };

    Cam.prototype.getRecordingJobConfiguration = function(options, callback) {
        options = options || {};
        const jobToken = options.JobToken || options.jobToken;
        if (!jobToken) {
            callbackMissingOption(this, callback, 'JobToken');
            return;
        }
        this._request({
            service: 'recording'
            , body: this._envelopeHeader() +
				'<GetRecordingJobConfiguration xmlns="http://www.onvif.org/ver10/recording/wsdl">' +
				'<JobToken>' + jobToken + '</JobToken>' +
				'</GetRecordingJobConfiguration>' +
				this._envelopeFooter()
        }, function(err, data, xml) {
            if (!err) {
                this.recordingJobConfiguration = linerase(data).getRecordingJobConfigurationResponse.jobConfiguration;
            }
            if (callback) {
                callback.call(this, err, this.recordingJobConfiguration, xml);
            }
        }.bind(this));
    };

    Cam.prototype.setRecordingJobMode = function(options, callback) {
        options = options || {};
        const jobToken = options.JobToken || options.jobToken;
        const mode = options.Mode || options.mode;
        if (!jobToken) {
            callbackMissingOption(this, callback, 'JobToken');
            return;
        }
        if (!mode) {
            callbackMissingOption(this, callback, 'Mode');
            return;
        }
        this._request({
            service: 'recording'
            , body: this._envelopeHeader() +
				'<SetRecordingJobMode xmlns="http://www.onvif.org/ver10/recording/wsdl">' +
				'<JobToken>' + jobToken + '</JobToken>' +
				'<Mode>' + mode + '</Mode>' +
				'</SetRecordingJobMode>' +
				this._envelopeFooter()
        }, function(err, data, xml) {
            if (!err) {
                this.recordingJobMode = linerase(data).SetRecordingJobMode;
            }
            if (callback) {
                callback.call(this, err, this.recordingJobMode, xml);
            }
        }.bind(this));
    };
};