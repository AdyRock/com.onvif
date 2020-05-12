'use strict';

const Homey = require('homey');
const DigestFetch = require('digest-fetch');
const fetch = require('node-fetch');
const fs = require('fs');

class CameraDevice extends Homey.Device {

	async onInit() {
		this.repairing = false;
		this.updatingEventImage = false;
		this.cam = null;
		this.eventImage = null;
		this.nowImage = null;
		this.eventTime = this.getStoreValue('eventTime');
		this.alarmTime = this.getStoreValue('alarmTime');
		this.cameraTime = null;
		this.authType = 0;
		this.unsubscribeRef = null;

		// Upgrade old device settings where the ip and port where part of the data
		const settings = this.getSettings();
		const devData = this.getData();
		if (!settings.ip) {
			await this.setSettings({
				'ip': devData.id,
				'port': devData.port.toString()
			})
		}

		this.preferPullEvents = settings.preferPullEvents;
		this.hasMotion = settings.hasMotion;

		this.id = devData.id;
		Homey.app.updateLog("Initialising CameraDevice (" + this.id + ")");

		if (this.hasCapability('alarm_motion')) {
			this.setCapabilityValue('alarm_motion', false);
		}

		if (this.getClass() != 'sensor') {
			this.setClass('sensor');
		}

		this.connectCamera(false)
			.catch(err => {
				Homey.app.updateLog("Check Camera Error (" + this.id + "): " + Homey.app.varToString(err), true);
			});

		this.registerCapabilityListener('motion_enabled', this.onCapabilityMotionEnable.bind(this));

		this.motionEnabledTrigger = new Homey.FlowCardTriggerDevice('motionEnabledTrigger');
		this.motionEnabledTrigger.register();

		this.motionDisabledTrigger = new Homey.FlowCardTriggerDevice('motionDisabledTrigger');
		this.motionDisabledTrigger.register();

		this.snapshotReadyTrigger = new Homey.FlowCardTriggerDevice('snapshotReadyTrigger');
		this.snapshotReadyTrigger.register();

		this.eventShotReadyTrigger = new Homey.FlowCardTriggerDevice('eventShotReadyTrigger');
		this.eventShotReadyTrigger.register();

		this.registerCapabilityListener('button.syncTime', async () => {
			// Set the Camera date to Homey's date
			Homey.app.updateLog("Syncing time (" + this.id + ")");

			Date.prototype.stdTimezoneOffset = () => {
				var jan = new Date(this.getFullYear(), 0, 1);
				var jul = new Date(this.getFullYear(), 6, 1);
				return Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
			}

			Date.prototype.isDstObserved = () => {
				return this.getTimezoneOffset() < this.stdTimezoneOffset();
			}

			var d = new Date();
			var dls = d.isDstObserved();

			this.cam.setSystemDateAndTime({
					'dateTime': d,
					'dateTimeType': 'Manual',
					'daylightSavings': dls
				},
				(err, date, xml) => {
					if (err) {
						Homey.app.updateLog("Check Camera Error (" + this.id + "): " + Homey.app.varToString(err), true);
					}
				});
		});
	}

	async onAdded() {
		Homey.app.updateLog('CameraDevice has been added (" + this.id + ")');
		//Allow some time for the validation check cam connection to disconnect
		await new Promise(resolve => setTimeout(resolve, 2000));
		await this.getDriver().getLastCredentials(this);
		this.connectCamera(true)
			.catch(this.error);
	}

	async onSettings(oldSettingsObj, newSettingsObj, changedKeysArr) {
		//console.log("Settings: ", oldSettingsObj, newSettingsObj, changedKeysArr);
		if (changedKeysArr.indexOf("username") >= 0) {
			this.username = newSettingsObj.username;
		}

		if (changedKeysArr.indexOf("password") >= 0) {
			this.password = newSettingsObj.password;
		}

		if (changedKeysArr.indexOf("timeFormat") >= 0) {
			this.setCapabilityValue('event_time', this.convertDate(this.eventTime, newSettingsObj));
			this.setCapabilityValue('tamper_time', this.convertDate(this.alarmTime, newSettingsObj));
			this.setCapabilityValue('date_time', this.convertDate(this.cameraTime, newSettingsObj));
		}

		if (changedKeysArr.indexOf("userSnapUrl") >= 0) {
			// refresh image settings after exiting this callback
			setImmediate(() => {
				this.setupImages();
				return;
			});
		}

		if (changedKeysArr.indexOf("preferPullEvents") >= 0) {
			// Changing preferred event method
			this.preferPullEvents = newSettingsObj.preferPullEvents;
			if (this.hasMotion && this.getCapabilityValue('motion_enabled')) {
				// Switch off the current even mode
				await Homey.app.unsubscribe(this.cam, this.unsubscribeRef);
				this.unsubscribeRef = null;

				// Turn on the new mode
				setImmediate(() => {
					this.listenForEvents(this.cam);
					return;
				});
			}
		}
	}

	async connectCamera(addingCamera) {
		if (this.repairing) {
			// Wait while repairing and try again later
			this.checkTimerId = setTimeout(this.connectCamera.bind(this, addingCamera), 2000);
		} else if (this.getStoreValue('initialised')) {
			let settings = this.getSettings();

			try {
				this.cam = await Homey.app.connectCamera(
					settings.ip,
					settings.port,
					settings.username,
					settings.password
				);

				this.cam.on('error', (msg, xml) => {
					Homey.app.updateLog("Global Camera event error (" + this.id + "): " + Homey.app.varToString(msg), true);
					if (xml) {
						Homey.app.updateLog("xml: " + Homey.app.varToString(xml));
					}
				});

				this.supportPushEvent = false;
				try {
					let services = await Homey.app.getServices(this.cam);
					services.forEach((service) => {
						let namespaceSplitted = service.namespace.split('.org/')[1].split('/');
						if (namespaceSplitted[1] == 'events') {
							let serviceCapabilities = service.capabilities.capabilities['$'];
							if (serviceCapabilities['MaxNotificationProducers'] > 0) {
								this.supportPushEvent = true;
								Homey.app.updateLog("** PushEvent supported on " + this.id);
							}
						}
					});
				} catch (err) {

				}

				//if (addingCamera) {
				let info = {};
				try {
					info = await Homey.app.getDeviceInformation(this.cam);
					Homey.app.updateLog("Camera Information (" + this.id + "): " + Homey.app.varToString(info, ));
				} catch (err) {
					Homey.app.updateLog("Get camera info error (" + this.id + "): " + err.stack, true);
				}

				let supportedEvents = [""];
				try {
					let capabilities = await Homey.app.getCapabilities(this.cam);
					this.hasPullPoints = Homey.app.hasPullSupport(capabilities, this.id);
					if (this.hasPullPoints || this.supportPushEvent) {
						supportedEvents = await Homey.app.hasEventTopics(this.cam);
					}
				} catch (err) {
					Homey.app.updateLog("Get camera capabilities error (" + this.id + "): " + err.stack, true);
				}
				Homey.app.updateLog("Supported Events(" + this.id + "): " + supportedEvents);

				let notificationMethods = "";
				if (this.supportPushEvent && this.hasPullPoints) {
					notificationMethods = Homey.__("Push_Pull_Supported"); //"Push and Pull supported: ";
					if (this.preferPullEvents) {
						notificationMethods += Homey.__("Using_Pull"); //"Using Pull";
					} else {
						notificationMethods += Homey.__("Using_Push"); //"Using Push";
					}
				} else if (this.hasPullPoints) {
					notificationMethods += Homey.__("Only_Pull_Supported"); //"Only Pull supported";
				} else if (this.supportPushEvent) {
					notificationMethods += Homey.__("OnlyPush_Supported"); // "Only Push supported";
				} else {
					notificationMethods = Homey.__("Not_Supported"); //"Not supported";
				}

				this.hasMotion = ((supportedEvents.indexOf('MOTION') >= 0) && (this.hasPullPoints || this.supportPushEvent));
				await this.setSettings({
					"manufacturer": info.manufacturer,
					"model": info.model,
					"serialNumber": info.serialNumber,
					"firmwareVersion": info.firmwareVersion,
					"hasMotion": this.hasMotion,
					'notificationMethods': notificationMethods,
					'notificationTypes': supportedEvents.toString()
				})

				settings = this.getSettings();

				if (!this.hasMotion) {
					Homey.app.updateLog("Removing unsupported motion capabilities for " + this.id);

					if (this.hasCapability('motion_enabled')) {
						this.removeCapability('motion_enabled');
					}
					if (this.hasCapability('alarm_motion')) {
						this.removeCapability('alarm_motion');
					}
					if (this.hasCapability('event_time')) {
						this.removeCapability('event_time');
					}
				}
				addingCamera = false;
				//}
				await this.setupImages();

				if (this.hasMotion) {
					if (this.getCapabilityValue('motion_enabled')) {
						// Motion detection is enabled so listen for events
						this.listenForEvents(this.cam);
					}
				}

				this.setAvailable();
				this.checkCamera = this.checkCamera.bind(this);
				this.checkTimerId = setTimeout(this.checkCamera, 10000);
				this.setCapabilityValue('alarm_tamper', false);
				Homey.app.updateLog("Camera (" + this.id + ") is ready");
			} catch (err) {
				if (!this.repairing) {
					Homey.app.updateLog("Connect to camera error (" + this.id + "): " + err.stack, true);
					this.setUnavailable();
				}
				this.checkTimerId = setTimeout(this.connectCamera.bind(this, addingCamera), 2000);
				this.setCapabilityValue('alarm_tamper', false);
			}
		}
	}

	async checkCamera() {
		if (!this.repairing) {
			this.cam.getSystemDateAndTime((err, date, xml) => {
				if (err) {
					err = String(err);
					Homey.app.updateLog("Check Camera Error (" + this.id + "): " + Homey.app.varToString(err), true);

					if (!this.getCapabilityValue('alarm_tamper')) {
						this.setCapabilityValue('alarm_tamper', true);
						this.alarmTime = new Date(Date.now());
						this.setStoreValue('alarmTime', this.alarmTime);
						this.setCapabilityValue('tamper_time', this.convertDate(this.alarmTime, this.getSettings()));
					}

					if (err.indexOf("EHOSTUNREACH") >= 0) {
						this.setUnavailable();
						this.unsubscribeRef = null;
					}
				} else if (this.getCapabilityValue('alarm_tamper')) {
					Homey.app.updateLog("Check Camera (" + this.id + "): back online");
					this.setCapabilityValue('alarm_tamper', false);
					this.setAvailable();

					if (this.hasMotion && this.getCapabilityValue('motion_enabled')) {
						//Restart event monitoring
						this.unsubscribeRef = null;
						setImmediate(() => {
							this.listenForEvents(this.cam);
							return;
						});
					}
				} else {
					this.setAvailable();
					this.cameraTime = date;
					this.setCapabilityValue('date_time', this.convertDate(this.cameraTime, this.getSettings()));
				}
			});
		}

		this.checkCamera = this.checkCamera.bind(this);
		this.checkTimerId = setTimeout(this.checkCamera, this.getCapabilityValue('alarm_tamper') ? 5000 : 10000);
	}

	convertDate(date, settings) {
		var strDate = "";
		if (date) {
			var d = new Date(date);

			if (settings.timeFormat == "mm_dd") {
				let mins = d.getMinutes();
				let dte = d.getDate();
				let mnth = d.getMonth() + 1;
				strDate = d.getHours() + ":" + (mins < 10 ? "0" : "") + mins + " " + (dte < 10 ? "0" : "") + dte + "-" + (mnth < 10 ? "0" : "") + mnth;
			} else if (settings.timeFormat == "system") {
				strDate = d.toLocaleString();
			} else {
				strDate = d.toJSON();
			}
		}

		return strDate;
	}

	async readEventImage() {
		const storageStream = fs.createWriteStream(Homey.app.getUserDataPath(this.eventImageFilename));

		if (this.invalidAfterConnect) {
			// Suggestions on the internet say this has to be called before getting the snapshot if invalidAfterConnect = true
			const snapURL = await Homey.app.getSnapshotURL(this.cam);
			this.snapUri = snapURL.uri;
		}

		const settings = this.getSettings();
		Homey.app.updateLog("Event snapshot URL (" + this.id + "): " + Homey.app.varToString(this.snapUri).replace(settings.password, "YOUR_PASSWORD"));

		var res = await this.doFetch("MOTION EVENT");
		if (!res.ok) {
			Homey.app.updateLog(Homey.app.varToString(res));
			throw new Error(res.statusText);
		}

		return new Promise((resolve, reject) => {
			res.body.pipe(storageStream);
			storageStream.on('error', (err) => {
				Homey.app.updateLog(Homey.app.varToString(err));
				return reject(err);
				//throw new Error(err);
			})
			storageStream.on('finish', () => {
				this.eventImage.update();
				Homey.app.updateLog("Event Image Updated (" + this.id + ")");

				let tokens = {
					'eventImage': this.eventImage
				}

				this.eventShotReadyTrigger
					.trigger(this, tokens)
					.catch(err => {
						Homey.app.updateLog("Snapshot error (" + this.id + "): " + Homey.app.varToString(err), true);
						return reject(err);
					})
					.then(() => {
						return resolve(true);
					})
			});
		});
	}

	async triggerMotionEvent(dataName, dataValue) {
		const settings = this.getSettings();
		this.setAvailable();

		if (dataValue) {
			// Set a timer to clear the motion
			clearTimeout(this.eventTimeoutId);
			this.eventTimeoutId = setTimeout(() => {
				this.setCapabilityValue('alarm_motion', false);
				console.log("Event off timeout");
			}, 180000);
		}
		if (this.getCapabilityValue('motion_enabled')) {
			if (!settings.single || dataValue != this.getCapabilityValue('alarm_motion')) {
				Homey.app.updateLog("Event Processing (" + this.id + "):" + dataName + " = " + dataValue);
				this.setCapabilityValue('alarm_motion', dataValue);
				if (dataValue) {
					if (!this.updatingEventImage) {
						this.updatingEventImage = true;

						// Safeguard against flag not being reset for some reason
						let timerId = setTimeout(() => {
							this.updatingEventImage = false
						}, settings.delay * 1000 + 20000);

						this.eventTime = new Date(Date.now());
						this.setStoreValue('eventTime', this.eventTime);
						this.setCapabilityValue('event_time', this.convertDate(this.eventTime, settings));
						if (settings.delay > 0) {
							await new Promise(resolve => setTimeout(resolve, settings.delay * 1000));
						}

						for (let retries = 3; retries > 0; retries--) {
							try {
								await this.readEventImage();
								break;
							} catch (err) {
								Homey.app.updateLog("Event image error (" + this.id + "): " + err);
								clearTimeout(timerId);
								timerId = setTimeout(() => {
									this.updatingEventImage = false
								}, 20000);
							}
						}

						this.updatingEventImage = false;
					} else {
						Homey.app.updateLog("** Event STILL Processing last image (" + this.id + ") **", true);
					}
				} else {
					clearTimeout(this.eventTimeoutId);
				}
			} else {
				Homey.app.updateLog("Ignoring unchanged event (" + this.id + ") " + dataName + " = " + dataValue);
			}
		}
	}

	async triggerTamperEvent(dataName, dataValue) {
		clearTimeout(this.checkTimerId);
		const settings = this.getSettings();
		this.setAvailable();

		if (dataValue != this.getCapabilityValue('alarm_tamper')) {
			Homey.app.updateLog("Event Processing (" + this.id + "):" + dataName + " = " + dataValue);
			this.setCapabilityValue('alarm_tamper', dataValue);
			if (dataValue) {
				this.alarmTime = new Date(Date.now());
				this.setStoreValue('alarmTime', this.alarmTime);
				this.setCapabilityValue('tamper_time', this.convertDate(this.alarmTime, this.getSettings()));
			}

			this.checkCamera = this.checkCamera.bind(this);
			this.checkTimerId = setTimeout(this.checkCamera, 10000);

		} else {
			Homey.app.updateLog("Ignoring unchanged event (" + this.id + ") " + dataName + " = " + dataValue);
		}
	}

	async subscribeToCamPushEvents(cam_obj) {
		clearTimeout(this.eventSubscriptionRenewTimerId);

		if (this.getCapabilityValue('motion_enabled')) {
			if (this.unsubscribeRef) {
				Homey.app.updateLog("Renew previous events: " + this.unsubscribeRef);
				cam_obj.RenewPushEventSubscription(this.unsubscribeRef, (err, info, xml) => {
					if (err) {
						Homey.app.updateLog("Renew subscription err (" + this.id + "): " + err);
						console.log(err);
						// Refresh was probably too late so subscribe again
						this.unsubscribeRef = null;
						setTimeout(this.subscribeToCamPushEvents.bind(this, cam_obj), 0);
					} else {

						Homey.app.updateLog("Renew subscription response (" + this.id + "): " + cam_obj.hostname + "info: " + info);
						let startTime = info[0].renewResponse[0].currentTime[0];
						let endTime = info[0].renewResponse[0].terminationTime[0];
						var d1 = new Date(startTime);
						var d2 = new Date(endTime);
						var refreshTime = ((d2.valueOf() - d1.valueOf())) - 5000;

						console.log("Push renew every (" + this.id + "): ", refreshTime);
						if (refreshTime < 5000) {
							refreshTime = 5000;
						}

						this.eventSubscriptionRenewTimerId = setTimeout(this.subscribeToCamPushEvents.bind(this, cam_obj), refreshTime);
					}
				});
			} else {
				const url = "http://" + Homey.app.homeyIP + ":" + Homey.app.pushServerPort + "/onvif/events?deviceId=" + this.id;
				Homey.app.updateLog("Setting up Push events (" + this.id + ") on: " + url);
				cam_obj.SubscribeToPushEvents(url, (err, info, xml) => {
					if (err) {
						Homey.app.updateLog("Subscribe err (" + this.id + "): " + err);
					} else {

						Homey.app.updateLog("Subscribe response (" + this.id + "): " + cam_obj.hostname + "Info: " + info[0].subscribeResponse[0].subscriptionReference[0].address);
						this.unsubscribeRef = info[0].subscribeResponse[0].subscriptionReference[0].address[0];
						console.log("Unsubscribe ref: ", this.unsubscribeRef, "\r\n");

						let startTime = info[0].subscribeResponse[0].currentTime[0];
						let endTime = info[0].subscribeResponse[0].terminationTime[0];
						var d1 = new Date(startTime);
						var d2 = new Date(endTime);
						var refreshTime = ((d2.valueOf() - d1.valueOf())) - 5000;

						console.log("Push renew every (" + this.id + "): ", refreshTime);
						if (refreshTime < 5000) {
							refreshTime = 5000;
						}

						this.eventSubscriptionRenewTimerId = setTimeout(this.subscribeToCamPushEvents.bind(this, cam_obj), refreshTime);
					}
				});
			}
		}
	}

	async listenForEvents(cam_obj) {
		//Stop listening for motion events before we add a new listener
		this.cam.removeAllListeners('event');

		if (this.getCapabilityValue('motion_enabled')) {
			if (this.updatingEventImage) {
				// Wait while repairing and try again later
				this.eventTimerId = setTimeout(this.listenForEvents.bind(this, cam_obj), 2000);
			} else {
				if (this.supportPushEvent && !this.preferPullEvents) {
					Homey.app.updateLog('\r\n## Waiting for Push events (' + this.id + ') ##');

					this.subscribeToCamPushEvents(cam_obj);
					return;
				}

				Homey.app.updateLog('## Waiting for Pull events (' + this.id + ') ##');
				cam_obj.on('event', (camMessage, xml) => {
					this.processCamEventMessage(camMessage);
				});
			}
		}
	}

	async processCamEventMessage(camMessage) {
		if (this.getCapabilityValue('motion_enabled')) {
			try {
				Homey.app.updateLog('\r\n--  Event detected (' + this.id + ')  --');
				//Homey.app.updateLog(Homey.app.varToString(camMessage));

				this.setAvailable();

				let eventTopic = camMessage.topic._
				eventTopic = Homey.app.stripNamespaces(eventTopic)

				let dataName = "";
				let dataValue = "";

				// DATA (Name:Value)
				if (camMessage.message.message.data && camMessage.message.message.data.simpleItem) {
					if (Array.isArray(camMessage.message.message.data.simpleItem)) {
						for (let x = 0; x < camMessage.message.message.data.simpleItem.length; x++) {
							dataName = camMessage.message.message.data.simpleItem[x].$.Name
							dataValue = camMessage.message.message.data.simpleItem[x].$.Value
						}
					} else {
						dataName = camMessage.message.message.data.simpleItem.$.Name
						dataValue = camMessage.message.message.data.simpleItem.$.Value
					}
				} else if (camMessage.message.message.data && camMessage.message.message.data.elementItem) {
					Homey.app.updateLog("WARNING: Data contain an elementItem")
					dataName = 'elementItem'
					dataValue = Homey.app.varToString(camMessage.message.message.data.elementItem)
				} else {
					Homey.app.updateLog("WARNING: Data does not contain a simpleItem or elementItem")
					dataName = null
					dataValue = null
				}

				if (dataName) {
					Homey.app.updateLog("Event data: (" + this.id + ") " + eventTopic + ": " + dataName + " = " + dataValue);
					if ((dataName === "IsMotion") || (dataName === "IsInside")) {
						this.triggerMotionEvent(dataName, dataValue);
					} else if (dataName === "IsTamper") {
						this.triggerTamperEvent(dataName, dataValue);
					} else {
						Homey.app.updateLog("Ignoring event type (" + this.id + ") " + eventTopic + ": " + dataName + " = " + dataValue);
					}
				}
			} catch (err) {
				Homey.app.updateLog("Camera Event Error (" + this.id + "): " + err.stack, true);
			}
		}
	}

	async onCapabilityMotionEnable(value, opts) {
		try {
			clearTimeout(this.eventSubscriptionRenewTimerId);
			clearTimeout(this.eventTimerId);

			console.log("onCapabilityMotionEnable: ", value);
			this.setCapabilityValue('alarm_motion', false);

			if (value && this.hasMotion) {
				Homey.app.updateLog("Switch motion detection On (" + this.id + ")");

				// Start listening for motion events
				setImmediate(() => {
					this.listenForEvents(this.cam);
					return;
				});

				this.motionEnabledTrigger
					.trigger(this)
					.catch(this.error)
					.then(this.log("Triggered enable on"))
			} else {
				try {
					Homey.app.updateLog("Switch motion detection Off (" + this.id + ")");

					// Switch off the current even mode
					await Homey.app.unsubscribe(this.cam, this.unsubscribeRef);
					this.unsubscribeRef = null;

				} catch (err) {
					this.unsubscribeRef = null;
					Homey.app.updateLog(this.getName() + " onCapabilityOff Error (" + this.id + ") " + err.stack, true);
				}

				this.motionDisabledTrigger
					.trigger(this)
					.catch(this.error)
					.then(this.log("triggered enable off"))
			}

		} catch (err) {
			//this.setUnavailable();
			Homey.app.updateLog(this.getName() + " onCapabilityOnoff Error (" + this.id + ") " + err.stack, true);
		}
	}

	async setupImages() {
		try {
			const devData = this.getData();
			const settings = this.getSettings();
			this.password = settings.password
			this.username = settings.username;

			this.invalidAfterConnect = false;

			// Use ONVIF snapshot URL
			const snapURL = await Homey.app.getSnapshotURL(this.cam);
			this.snapUri = snapURL.uri;
			this.invalidAfterConnect = snapURL.invalidAfterConnect;

			const publicSnapURL = this.snapUri.replace(this.password, "YOUR_PASSWORD");
			await this.setSettings({
				"url": publicSnapURL
			})

			Homey.app.updateLog("Snapshot URL: " + Homey.app.varToString(this.snapUri).replace(this.password, "YOUR_PASSWORD"));

			try {
				if (this.hasMotion) {
					const imageFilename = 'eventImage' + devData.id;
					this.eventImageFilename = imageFilename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
					this.eventImageFilename += ".jpg";
					Homey.app.updateLog("SnapShot save file (" + this.id + ") = " + this.eventImageFilename);

					const eventImagePath = Homey.app.getUserDataPath(this.eventImageFilename);
					if (!fs.existsSync(eventImagePath)) {
						this.updatingEventImage = true;

						Homey.app.updateLog("Initialising event image (" + this.id + ")");
						// Initialise the event image with the current snapshot
						const storageStream = fs.createWriteStream(eventImagePath);
						Homey.app.updateLog("Fetching event image (" + this.id + ")");

						if (this.invalidAfterConnect) {
							// Suggestions on the internet say this has to be called before getting the snapshot if invalidAfterConnect = true
							await Homey.app.getSnapshotURL(this.cam)
						}

						var res = await this.doFetch("Motion Event");
						if (!res.ok) {
							Homey.app.updateLog("Fetch MOTION error (" + this.id + "): " + Homey.app.varToString(res));
							this.updatingEventImage = false;
							throw new Error(res.statusText);
						}

						res.body.pipe(storageStream);

						storageStream.on('error', (err) => {
							Homey.app.updateLog("Fetch event image error (" + this.id + "): " + err.stack, true);
							this.updatingEventImage = false;
						})
						storageStream.on('finish', () => {
							Homey.app.updateLog("Event Image Updated (" + this.id + ")");
							this.updatingEventImage = false;
						});

						// Allow time for the image to download before setting up the view image
						await new Promise(resolve => setTimeout(resolve, 2000));
					}

					if (!this.eventImage) {
						Homey.app.updateLog("Registering event image (" + this.id + ")");
						this.eventImage = new Homey.Image();
						this.eventImage.setPath(eventImagePath);
						this.eventImage.register()
							.then(() => {
								Homey.app.updateLog("registered event image (" + this.id + ")")
								this.setCameraImage('Event', Homey.__("Motion_Event"), this.eventImage);
							})
							.catch((err) => {
								Homey.app.updateLog("Register event image error (" + this.id + "): " + err.stack, true);
							});
					}
				}
			} catch (err) {
				Homey.app.updateLog("Event SnapShot error (" + this.id + "): " + err.stack, true);
				this.updatingEventImage = false;
			}

			if (!this.nowImage) {
				this.nowImage = new Homey.Image();
				this.nowImage.setStream(async (stream) => {
					if (this.invalidAfterConnect) {
						await Homey.app.getSnapshotURL(this.cam)
					}

					var res = await this.doFetch("NOW");
					if (!res.ok) {
						Homey.app.updateLog("Fetch NOW error (" + this.id + "): " + res.statusText);
						console.log(res);
						console.log(res.headers.raw());
						throw new Error(res.statusText);
					}

					res.body.pipe(stream);

					stream.on('error', (err) => {
						Homey.app.updateLog("Fetch event image error (" + this.id + "): " + err.stack, true);
					})
					stream.on('finish', () => {
						Homey.app.updateLog("Event Image Updated (" + this.id + ")");
					});
				});

				Homey.app.updateLog("Registering now image (" + this.id + ")");
				this.nowImage.register()
					.then(() => {
						Homey.app.updateLog("registered now image (" + this.id + ")")
						this.setCameraImage('Now', Homey.__("Now"), this.nowImage);
					})
					.catch((err) => {
						Homey.app.updateLog("Register now image error (" + this.id + "): " + err.stack, true);
					});
			}
		} catch (err) {
			//Homey.app.updateLog("SnapShot error: " + Homey.app.varToString(err), true);
			Homey.app.updateLog("SnapShot error (" + this.id + "): " + err.stack, true);
		}
	}

	async doFetch(name) {
		var res = {};
		try {
			if (this.authType == 0) {
				Homey.app.updateLog("Fetching (" + this.id + ") " + name + " image from: " + this.snapUri);
				res = await fetch(this.snapUri);
				if (res.status == 401) {
					// Try Basic Authentication
					this.authType = 1;
				}
			}

			if (this.authType == 1) {
				Homey.app.updateLog("Fetching (" + this.id + ") " + name + " image with Basic Auth. From: " + this.snapUri);

				const client = new DigestFetch(this.username, this.password, {
					basic: true
				});
				res = await client.fetch(this.snapUri);
				if (res.status == 401) {
					// Try Digest Authentication
					this.authType = 2;
				}
			}

			if (this.authType >= 2) {
				Homey.app.updateLog("Fetching (" + this.id + ") " + name + " image with Digest Auth. From: " + this.snapUri);

				const client = new DigestFetch(this.username, this.password, {
					algorithm: 'MD5'
				});
				res = await client.fetch(this.snapUri);
				if (res.status == 401) {
					// Go back to no Authentication
					this.authType = 0;
				}
			}
		} catch (err) {
			Homey.app.updateLog("SnapShot error (" + this.id + "): " + err.stack, true);
			res = {
				'ok': false,
				'statusText': err.message
			};
		}

		return res;
	}

	onDeleted() {
		try {
			clearTimeout(this.eventSubscriptionRenewTimerId);
			clearTimeout(this.eventTimerId);
			if (this.cam) {
				//Stop listening for motion events
				this.cam.removeAllListeners('event');

				if (this.unsubscribeRef) {
					this.cam.UnsubscribePushEventSubscription(this.unsubscribeRef);
				}
			}

			if (this.eventImageFilename) {
				const eventImagePath = Homey.app.getUserDataPath(this.eventImageFilename);
				if (!fs.existsSync(eventImagePath)) {
					fs.unlink(eventImagePath, (err) => {
						if (!err) {
							//console.log('successfully deleted: ', this.eventImageFilename);
						}
					});
				}
			}
			console.log("Delete device");
		} catch (err) {
			console.log("Delete device error", err);
		}
	}
}

module.exports = CameraDevice;