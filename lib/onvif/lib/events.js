/**
 * @namespace cam
 * @description Events section for Cam class
 * @author Andrew D.Laptev <a.d.laptev@gmail.com>
 * @licence MIT
 */
const Homey = require('homey');

module.exports = function (Cam) {

	/**
	 * @typedef {object} Cam~CreatePullPointSubscriptionResponse
	 * @property {object} subscriptionReference
	 * @property {string|object} subscriptionReference.address
	 * @property {Date} currentTime
	 * @property {Date} terminationTime
	 */

	/**
	 * Events namespace for the device, stores all information about device events
	 * @name Cam#events
	 * @type object
	 * @property {Cam~EventProperties} properties
	 * @property {Cam~CreatePullPointSubscriptionResponse} subscription
	 * @property {Date} terminationTime Time when pull-point subscription is over
	 * @property {number} messageLimit Pull message count
	 */

	const linerase = require('./utils').linerase;

	/**
	 * Event properties object
	 * @typedef {object} Cam~EventProperties
	 * @property {array} topicNamespaceLocation
	 * @property {object} topicSet
	 * @property {array} topicExpressionDialect
	 */

	/**
	 * @callback Cam~GetEventPropertiesCallback
	 * @property {?Error} err
	 * @property {Cam~EventProperties} response
	 * @property {string} response xml
	 */

	/**
	 * Get event properties of the device. Sets `events` property of the device
	 * @param {Cam~GetEventPropertiesCallback} callback
	 */
	Cam.prototype.getEventProperties = function (callback) {
		this._request({
			service: 'events',
			body: this._envelopeHeader() +
				'<GetEventProperties xmlns="http://www.onvif.org/ver10/events/wsdl"/>' +
				this._envelopeFooter()
		}, function (err, res, xml) {
			if (!err) {
				this.events.properties = linerase(res).getEventPropertiesResponse;
			}
			else{
				Homey.app.updateLog("!!!!! getEventServiceCapabilities error: " + Homey.app.varToString(err) + "\n", true);
			}
			callback.call(this, err, err ? null : this.events.properties, xml);
		}.bind(this));
	};

	/**
	 * Get event service capabilities
	 * @param {function} callback
	 */
	Cam.prototype.getEventServiceCapabilities = function (callback) {
		this._request({
			service: 'events',
			body: this._envelopeHeader() +
				'<GetServiceCapabilities xmlns="http://www.onvif.org/ver10/events/wsdl"/>' +
				this._envelopeFooter()
		}, function (err, res, xml) {
			if (!err) {
				var data = linerase(res[0].getServiceCapabilitiesResponse[0].capabilities[0].$);
			}
			else{
				Homey.app.updateLog("!!!!! getEventServiceCapabilities error: " + Homey.app.varToString(err) + "\n", true);
			}
			callback.call(this, err, data, xml);
		}.bind(this));
	};

	/**
	 * Create pull-point subscription
	 * @param {function} callback
	 */
	Cam.prototype.createPullPointSubscription = function (callback) {
		this._request({
			service: 'events',
			body: this._envelopeHeader() +
				'<CreatePullPointSubscription xmlns="http://www.onvif.org/ver10/events/wsdl">' +
				'<InitialTerminationTime>PT60S</InitialTerminationTime>' +
				'</CreatePullPointSubscription>' +
				this._envelopeFooter()
		}, function (err, res, xml) {
			Homey.app.updateLog("*** createPullPointSubscription returned:\n" + Homey.app.varToString(xml) + "\n");
			if (!err) {
				this.events.subscription = linerase(res[0].createPullPointSubscriptionResponse[0]);

				//Homey.app.updateLog("createPullPointSubscription: " + Homey.app.varToString(res) + "\naddress: " + Homey.app.varToString(this.events.subscription.subscriptionReference.address) + "\n");
				this.events.subscription.subscriptionReference.address = this.events.subscription.subscriptionReference.address.replace("255.255.255.255", this.hostname);
				this.events.subscription.subscriptionReference.address = this._parseUrl(this.events.subscription.subscriptionReference.address);
				this.events.terminationTime = _terminationTime(this.events.subscription);

				Homey.app.updateLog("createPullPointSubscription parsed: " + Homey.app.varToString(this.events.subscription.subscriptionReference.address) + "\n");

			}
			else{
				Homey.app.updateLog("!!!!! createPullPointSubscription error: " + Homey.app.varToString(err) + "\n", true);
			}
			try {
				callback.call(this, err, err ? null : this.events.subscription, xml);
			} catch (err) {
				Homey.app.updateLog("!!!!! createPullPointSubscription callback error: " + Homey.app.varToString(err) + "\n", true);
				this.emit('error', err, xml);
			}

		}.bind(this));
	};


	/**
	 * Create push subscription
	 * @param {function} callback
	 */
	Cam.prototype.SubscribeToPushEvents = function (Url, callback) {
		this._request({
			service: 'events',
			body: this._envelopeHeader(true) +
				'<a:Action> ' +
				'http://docs.oasis-open.org/wsn/bw-2/NotificationProducer/SubscribeRequest' +
				'</a:Action>' +
				'<a:ReplyTo>' +
				'<a:Address>http://www.w3.org/2005/08/addressing/anonymous</a:Address>' +
				'</a:ReplyTo>' +

				'<a:To>' +
				this.hostname + ':' + this.port + '/onvif' +
				'</a:To>' +

				'</s:Header>' +
				'<s:Body>' +
				'<Subscribe xmlns="http://docs.oasis-open.org/wsn/b-2">' +
				'<ConsumerReference>' +
				'<a:Address>' +
				Url +
				'</a:Address>' +
				'</ConsumerReference>' +

				// '<Filter>' +
				// 	'<TopicExpression Dialect="http://www.onvif.org/ver10/tev/topicExpression/ConcreteSet" xmlns:tns1="http://www.onvif.org/ver10/topics">' +
				// 		'tns1:RuleEngine' +
				// 	'</TopicExpression>' +
				// '</Filter>'+

				'<InitialTerminationTime>' +
				'PT5M' +
				'</InitialTerminationTime>' +
				'</Subscribe>' +
				this._envelopeFooter()
		}, function (err, res, xml) {
			try {
				callback.call(this, err, err ? null : res, xml);
			} catch (err) {
				this.emit('error', err, xml);
			}

		}.bind(this));
	};

	/**
	 * Renew push subscription
	 * @param {function} callback
	 */
	Cam.prototype.RenewPushEventSubscription = function (Url, callback) {
		this._request({
			service: 'events',
			body: this._envelopeHeader(true) +
				'<a:Action> ' +
				'http://docs.oasis-open.org/wsn/bw-2/NotificationProducer/RenewRequest' +
				'</a:Action>' +
				'<a:ReplyTo>' +
				'<a:Address>http://www.w3.org/2005/08/addressing/anonymous</a:Address>' +
				'</a:ReplyTo>' +

				'<a:To>' +
				Url +
				'</a:To>' +

				'</s:Header>' +
				'<s:Body>' +
				'<Renew xmlns="http://docs.oasis-open.org/wsn/b-2">' +
				'<TerminationTime>' +
				'PT5M' +
				'</TerminationTime>' +
				'</Renew>' +
				this._envelopeFooter()
		}, function (err, res, xml) {
			try {
				callback.call(this, err, err ? null : res, xml);
			} catch (err) {
				this.emit('error', err, xml);
			}

		}.bind(this));
	};

	/**
	 * Create unsubscribe push subscription
	 * @param {function} callback
	 */
	Cam.prototype.UnsubscribePushEventSubscription = function (Url, callback) {
		this._request({
			service: 'events',
			body: this._envelopeHeader(true) +
				'<a:Action> ' +
				'http://docs.oasis-open.org/wsn/bw-2/SubscriptionManager/UnsubscribeRequest' +
				'</a:Action>' +
				'<a:To>' +
				Url +
				'</a:To>' +
				'</s:Header>' +
				'<s:Body>' +
				'<Unsubscribe xmlns="http://docs.oasis-open.org/wsn/b-2" />' +
				this._envelopeFooter()
		}, function (err, res, xml) {
			try {
				if (callback) {
					callback.call(this, err, err ? null : res, xml);
				}
			} catch (err) {
				callback.call(this, err, err ? null : res, xml);
			}

		}.bind(this));
	};

	/**
	 * Renew pull-point subscription
	 * @param {options} callback
	 * @param {function} callback
	 */

	Cam.prototype.renew = function (options, callback) {
		let urlAddress = null;
		let subscriptionId = null;
		try {
			urlAddress = this.events.subscription.subscriptionReference.address;
		} catch (e) {
			throw new Error('You should create pull-point subscription first!');
		}

		try {
			subscriptionId = this.events.subscription.subscriptionReference.referenceParameters.subscriptionId
		} catch (e) {
			subscriptionId = null;
		}

		let sendXml = this._envelopeHeader(true);

		if (!subscriptionId) {
			sendXml += '<a:To>' + urlAddress.href + '</a:To>'
		} else {
			// Axis Cameras use a PullPoint URL and the Subscription ID
			sendXml += '<a:To mustUnderstand="1">' + urlAddress.href + '</a:To>' +
				'<SubscriptionId xmlns="http://www.axis.com/2009/event" a:IsReferenceParameter="true">' + this.events.subscription.subscriptionReference.referenceParameters.subscriptionId + '</SubscriptionId>'
		}
		sendXml += '</s:Header>' +
			'<s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">' +
			'<Renew xmlns="http://docs.oasis-open.org/wsn/b-2">' +
			'<TerminationTime>PT60S</TerminationTime>' +
			'</Renew>' +
			this._envelopeFooter()
		this._request({
			url: urlAddress,
			body: sendXml
		}, function (err, res, xml) {
			if (!err) {
				var data = linerase(res).renewResponse;
			}
			else{
				Homey.app.updateLog("!!!!! renew error: " + Homey.app.varToString(err) + "\n", true);
			}
			callback.call(this, err, data, xml);
		}.bind(this));
	};



	/**
	 * @typedef {object} Cam~Event
	 * @property {Date} currentTime
	 * @property {Date} terminationTime
	 * @property {Cam~NotificationMessage|Array.<Cam~NotificationMessage>} [notificationMessage]
	 */

	/**
	 * @typedef {object} Cam~NotificationMessage
	 * @property {string} subscriptionReference.address Pull-point address
	 * @property {string} topic._ Namespace of message topic
	 * @property {object} message Message object
	 */

	/**
	 * @callback Cam~PullMessagesResponse
	 * @property {?Error} error
	 * @property {Cam~Event} response Message
	 * @property {string} xml Raw SOAP response
	 */

	/**
	 * Pull messages from pull-point subscription
	 * @param options
	 * @param {number} [options.messageLimit=10]
	 * @param {Cam~PullMessagesResponse} callback
	 * @throws {Error} {@link Cam#events.subscription} must exists
	 */
	Cam.prototype.pullMessages = function (options, callback) {
		let urlAddress = null;
		let subscriptionId = null;
		try {
			urlAddress = this.events.subscription.subscriptionReference.address;
		} catch (e) {
			throw new Error('You should create pull-point subscription first!');
		}

		try {
			subscriptionId = this.events.subscription.subscriptionReference.referenceParameters.subscriptionId
		} catch (e) {
			subscriptionId = null;
		}

		let sendXml = this._envelopeHeader(true);

		if (!subscriptionId) {
			sendXml += '<a:To>' + urlAddress.href + '</a:To>'
		} else {
			// Axis Cameras use a PullPoint URL and the Subscription ID
			sendXml += '<a:To mustUnderstand="1">' + urlAddress.href + '</a:To>' +
				'<SubscriptionId xmlns="http://www.axis.com/2009/event" a:IsReferenceParameter="true">' + subscriptionId + '</SubscriptionId>'
		}
		sendXml += '</s:Header>' +
			'<s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">' +
			'<PullMessages xmlns="http://www.onvif.org/ver10/events/wsdl">' +
			'<Timeout>PT5S</Timeout>' + // pull timeout must be shorter than Socket timeout or we will get a socket error when there are no new events
			'<MessageLimit>' + (options.messageLimit || 10) + '</MessageLimit>' +
			'</PullMessages>' +
			this._envelopeFooter();
		this._request({
			url: urlAddress,
			body: sendXml
		}, function (err, res, xml) {
			if (!err) {
				var data = linerase(res).pullMessagesResponse;
			}
			else{
				Homey.app.updateLog("!!!!! pullMessage error: " + Homey.app.varToString(err) + "\n", true);
			}
			callback.call(this, err, data, xml);
		}.bind(this));
	};

	/**
	 * Unsubscribe from pull-point subscription
	 * @param {Cam~PullMessagesResponse} callback
	 * @throws {Error} {@link Cam#events.subscription} must exists
	 */
	Cam.prototype.unsubscribe = function (callback) {
		let urlAddress = null;
		let subscriptionId = null;
		try {
			urlAddress = this.events.subscription.subscriptionReference.address;
		} catch (e) {
			throw new Error('You should create pull-point subscription first!');
		}

		try {
			subscriptionId = this.events.subscription.subscriptionReference.referenceParameters.subscriptionId
		} catch (e) {
			subscriptionId = null;
		}

		let sendXml = this._envelopeHeader(true);

		if (!subscriptionId) {
			sendXml += '<a:To>' + urlAddress.href + '</a:To>'
		} else {
			// Axis Cameras use a PullPoint URL and the Subscription ID
			sendXml += '<a:To mustUnderstand="1">' + urlAddress.href + '</a:To>' +
				'<SubscriptionId xmlns="http://www.axis.com/2009/event" a:IsReferenceParameter="true">' + subscriptionId + '</SubscriptionId>'
		}
		sendXml += '</s:Header>' +
			'<s:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">' +
			'<Unsubscribe xmlns="http://docs.oasis-open.org/wsn/b-2"/>' +
			this._envelopeFooter()
		this._request({
			url: urlAddress,
			body: sendXml
		}, function (err, res, xml) {
			if (!err) {
				this.eventEmitter.removeAllListeners('event'); // We can subscribe again only if there is no 'event' listener
				var data = linerase(res).unsubscribeResponse;
			}
			else{
				Homey.app.updateLog("!!!!! unsubscribe error: " + Homey.app.varToString(err) + "\n", true);
			}
			if (callback) {
				callback.call(this, err, data, xml);
			}
		}.bind(this));
	};

	/**
	 * Count time before pull-point subscription terminates
	 * @param {Cam~CreatePullPointSubscriptionResponse} response
	 * @returns {Date}
	 * @private
	 */
	function _terminationTime(response) {
		return new Date(Date.now() - response.currentTime.getTime() + response.terminationTime.getTime());
	}

	/**
	 * Event loop for pullMessages request
	 * @private
	 */
	Cam.prototype._eventRequest = function (ForceNew) {
		if (this.eventEmitter.listeners('event').length) { // check for event listeners, if zero, stop pulling
			this.events.timeout = this.events.timeout || 30000; // setting timeout
			this.events.messageLimit = this.events.messageLimit || 10; // setting message limit
			if (ForceNew || !this.events.terminationTime || (this.events.terminationTime < Date.now() + this.events.timeout)) {
				// if there is no pull-point subscription or it will be dead soon, create new
				this.createPullPointSubscription(this._eventPull.bind(this));
			} else {
				this._eventPull();
			}
		} else {
			delete this.events.terminationTime;

			this.unsubscribe();
		}
	};

	/**
	 * Event loop for pullMessages request
	 * @private
	 */
	Cam.prototype._eventPull = function (err) {
		if (err) {
			if (this.eventEmitter.listeners('event').length === 0) {
				delete this.events.terminationTime;
				this.unsubscribe();
			} else {
				Homey.app.updateLog("!!!!! _eventPull error 1: " + Homey.app.varToString(err) + "\n", true);
				setTimeout(this._eventRequest.bind(this), 1000);
			}
		}
		else if (this.eventEmitter.listeners('event').length) { // check for event listeners, if zero, stop pulling
			this.pullMessages({
				messageLimit: this.events.messageLimit
			}, function (err, data, xml) {
				if (!err) {
					if (data.notificationMessage) {
						if (!Array.isArray(data.notificationMessage)) {
							data.notificationMessage = [data.notificationMessage];
						}
						data.notificationMessage.forEach(function (message) {
							/**
							 * Indicates message from device.
							 * @event Cam#event
							 * @type {Cam~NotificationMessage}
							 */
							this.emit('event', message, xml);
						}.bind(this));
					}

					this.events.terminationTime = _terminationTime(data); // Axis does not increment the termination time. Use RENEW

					// Axis cameras require us to Renew the Pull Point Subscription
					this.renew({}, function (err, data) {
						if (!err) {
							this.events.terminationTime = _terminationTime(data);
						}
						else{
							Homey.app.updateLog("!!!!! _eventPull renew error: " + Homey.app.varToString(err) + "\n", true);
						}
					})
				}
				else{
					Homey.app.updateLog("!!!!! _eventPull error 3: " + Homey.app.varToString(err) + "\n", true);
					setTimeout(this._eventRequest.bind(this), 1000, true);
					return;
				}
				// this._eventRequest = this._eventRequest.bind(this);
				// setTimeout(this._eventRequest, 500);
				this._eventRequest()
			}.bind(this));
		} else {
			delete this.events.terminationTime;
			this.unsubscribe();
		}
	};
};