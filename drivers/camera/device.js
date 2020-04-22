'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
var fs = require('fs');

class CameraDevice extends Homey.Device {

	onInit() {
		Homey.app.updateLog("Initialising CameraDevice");
		this.cam = null;
		this.eventImage = null;
		this.nowImage = null;
		this.eventTime = this.getStoreValue('eventTime');
		this.alarmTime = this.getStoreValue('alarmTime');
		this.cameraTime = null;

		this.connectCamera(false)
			.catch(err => {
				Homey.app.updateLog("Check Camera Error: " + JSON.stringify(err, null, 2), true);
			});

		this.registerCapabilityListener('motion_enabled', this.onCapabilityMotionEnable.bind(this));

		this.motionEnabledTrigger = new Homey.FlowCardTriggerDevice('motionEnabledTrigger');
		this.motionEnabledTrigger.register();

		this.motionDisabledTrigger = new Homey.FlowCardTriggerDevice('motionDisabledTrigger');
		this.motionDisabledTrigger.register();

		this.registerCapabilityListener('button.syncTime', async () => {
			// Set the Camera date to Homey's date
			Homey.app.updateLog("Syncing time");

			Date.prototype.stdTimezoneOffset = function () {
				var jan = new Date(this.getFullYear(), 0, 1);
				var jul = new Date(this.getFullYear(), 6, 1);
				return Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
			}

			Date.prototype.isDstObserved = function () {
				return this.getTimezoneOffset() < this.stdTimezoneOffset();
			}

			var d = new Date();
			var dls = d.isDstObserved();

			this.cam.setSystemDateAndTime({
					'dateTime': d,
					'dateTimeType': 'Manual',
					'daylightSavings': dls
				},
				function (err, date, xml) {
					if (err) {
						Homey.app.updateLog("Check Camera Error: " + JSON.stringify(err, null, 2), true);
					}
				}.bind(this));
		});
	}

	async onAdded() {
		Homey.app.updateLog('CameraDevice has been added');
		//Allow some time for the validation check cam connection to disconnect
		await new Promise(resolve => setTimeout(resolve, 2000));
		await this.getDriver().getLastCredentials(this);
		this.connectCamera(true)
			.catch(this.error);
	}

	async onSettings(oldSettingsObj, newSettingsObj, changedKeysArr) {
		//console.log("Settings: ", oldSettingsObj, newSettingsObj, changedKeysArr);
		if (changedKeysArr.indexOf("hasMotion") >= 0) {
			if (newSettingsObj.hasMotion) {
				// hasMotion switched on so add the motion capabilities
				this.addCapability('motion_enabled');
				this.addCapability('alarm_motion');
				this.addCapability('event_time');
				this.setupImages();
			} else {
				// hasMotion turned off
				this.removeCapability('motion_enabled');
				this.removeCapability('alarm_motion');
				this.removeCapability('event_time');
			}
		}

		if (changedKeysArr.indexOf("timeFormat") >= 0) {
			this.setCapabilityValue('event_time', this.convertDate(this.eventTime, newSettingsObj));
			this.setCapabilityValue('tamper_time', this.convertDate(this.alarmTime, newSettingsObj));
			this.setCapabilityValue('date_time', this.convertDate(this.cameraTime, newSettingsObj));
		}
	}

	async connectCamera(addingCamera) {
		if (this.getStoreValue('initialised')) {
			const devData = this.getData();
			Homey.app.updateLog("Dev Data: " + JSON.stringify(devData, null, 2));
			let settings = this.getSettings();

			try {
				this.cam = await Homey.app.connectCamera(
					devData.id,
					devData.port,
					settings.username,
					settings.password
				);

				this.cam.on('error', function (msg, xml) {
					Homey.app.updateLog("Camera event error: " + JSON.stringify(msg, null, 2), true);
					if (xml) {
						Homey.app.updateLog("xml: " + JSON.stringify(xml, null, 2));
					}
				}.bind(this));

				if (addingCamera) {
					let info = {};
					try {
						info = await Homey.app.getDeviceInformation(this.cam);
						Homey.app.updateLog("Camera Information: " + JSON.stringify(info, null, 2));
					} catch (err) {
						Homey.app.updateLog("Get camera info error: " + JSON.stringify(err, null, 2), true);
					}

					let supportedEvents = [""];
					try {
						let capabilities = await Homey.app.getCapabilities(this.cam);
						let hasEvents = Homey.app.hasPullSupport(capabilities);
						if (hasEvents) {
							supportedEvents = await Homey.app.hasEventTopics(this.cam);
						}
					} catch (err) {
						Homey.app.updateLog("Get camera capabilities error: " + JSON.stringify(err, null, 2), true);
					}
					Homey.app.updateLog("Supported Events: " + supportedEvents);

					await this.setSettings({
							"manufacturer": info.manufacturer,
							"model": info.model,
							"serialNumber": info.serialNumber,
							"firmwareVersion": info.firmwareVersion,
							"hasMotion": (supportedEvents.indexOf('MOTION') >= 0)
						})

					settings = this.getSettings();

					if (!settings.hasMotion) {
						Homey.app.updateLog("Removing unsupported motion capabilities");
	
						if (this.hasCapability('motion_enabled')) {
							this.removeCapability('motion_enabled');
						}
						if (this.hasCapability('alarm_motion')) {
							this.removeCapability('alarm_motion');
						}
						if (this.hasCapability('event_time')) {
							this.removeCapability('event_time');
						}
					} else {
						if (this.getCapabilityValue('motion_enabled')) {
							// Motion detection is enabled so listen for events
							this.listenForEvents(this.cam);
						}
					}
						addingCamera = false;
				}

				await this.setupImages();

				this.setAvailable();
				this.checkCamera = this.checkCamera.bind(this);
				this.checkTimerId = setTimeout(this.checkCamera, 10000);
				this.setCapabilityValue('alarm_tamper', false);
			} catch (err) {
				Homey.app.updateLog("Connect to camera error: " + err, true);
				this.setUnavailable();
				this.checkTimerId = setTimeout(this.connectCamera.bind(this, addingCamera), 1000);
				this.setCapabilityValue('alarm_tamper', false);
			}
		}
	}

	async checkCamera() {
		this.cam.getSystemDateAndTime(function (err, date, xml) {
			if (err) {
				err = String(err);
				Homey.app.updateLog("Check Camera Error: " + JSON.stringify(err, null, 2), true);
				if (err.indexOf("EHOSTUNREACH") >= 0) {
					this.setUnavailable();
				} else if (err.indexOf("Network timeout") >= 0) {
					if (!this.getCapabilityValue('alarm_tamper')) {
						this.setCapabilityValue('alarm_tamper', true);
						this.alarmTime = new Date(Date.now());
						this.setStoreValue('alarmTime', this.alarmTime);
						this.setCapabilityValue('tamper_time', this.convertDate(this.alarmTime, this.getSettings()));
					}
				}
			} else if (this.getCapabilityValue('alarm_tamper')) {
				this.setCapabilityValue('alarm_tamper', false);
				this.setAvailable();
			} else {
				this.cameraTime = date;
				this.setCapabilityValue('date_time', this.convertDate(this.cameraTime, this.getSettings()));
			}
		}.bind(this));

		this.checkCamera = this.checkCamera.bind(this);
		this.checkTimerId = setTimeout(this.checkCamera, this.getCapabilityValue('alarm_tamper') ? 30000 : 100000);
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

	async listenForEvents(cam_obj) {
		//Stop listening for motion events before we add a new listener
		this.cam.removeAllListeners('event');

		Homey.app.updateLog('######    Waiting for events   ######');
		const camSnapPath = await Homey.app.getSnapshotURL(this.cam);
		const eventImage = this.eventImage;

		cam_obj.on('event', async (camMessage, xml) => {
			try {
				Homey.app.updateLog('------    Event detected   ------');
				Homey.app.updateLog(JSON.stringify(camMessage, null, 2));

				this.setAvailable();

				let eventTopic = camMessage.topic._
				eventTopic = Homey.app.stripNamespaces(eventTopic)
				Homey.app.updateLog(JSON.stringify(eventTopic, null, 2));

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
					dataValue = JSON.stringify(camMessage.message.message.data.elementItem)
				} else {
					Homey.app.updateLog("WARNING: Data does not contain a simpleItem or elementItem")
					dataName = null
					dataValue = null
				}

				if (dataName) {
					Homey.app.updateLog("Event " + dataName + " = " + dataValue);
					if (dataName === "IsMotion") {
						const settings = this.getSettings();

						if (!settings.single || dataValue != this.getCapabilityValue('alarm_motion')) {
							Homey.app.updateLog("Event Processing", dataName, " = ", dataValue);
							this.setCapabilityValue('alarm_motion', dataValue);
							if (dataValue) {
								this.eventTime = new Date(Date.now());
								this.setStoreValue('eventTime', this.eventTime);
								this.setCapabilityValue('event_time', this.convertDate(this.eventTime, settings));
								if (settings.delay > 0) {
									await new Promise(resolve => setTimeout(resolve, settings.delay * 1000));
								}
								const storageStream = fs.createWriteStream(Homey.app.getUserDataPath(this.eventImageFilename));
								const res = await fetch(camSnapPath.uri);
								if (!res.ok) throw new Error(res.statusText);
								res.body.pipe(storageStream);
								storageStream.on('error', function (err) {
									Homey.app.updateLog(JSON.stringify(err, null, 2));
								})
								storageStream.on('finish', function () {
									eventImage.update();
									Homey.app.updateLog("Event Image Updated");
								});
							}
						}
					}
				}
			} catch (err) {
				Homey.app.updateLog("Camera Event Error: " + JSON.stringify(err, null, 2), true);
			}
		});
	}

	async onCapabilityMotionEnable(value, opts) {
		try {
			Homey.app.updateLog("Switch motion detection On/Off: " + value);
			this.setCapabilityValue('alarm_motion', false);
			const settings = this.getSettings();

			if (value && settings.hasMotion) {
				// Start listening for motion events
				this.listenForEvents(this.cam);

				this.motionEnabledTrigger
					.trigger(this)
					.catch(this.error)
					.then(this.log("Triggered enable on"))
			} else {
				//Stop listening for motion events
				this.cam.removeAllListeners('event');

				this.motionDisabledTrigger
					.trigger(this)
					.catch(this.error)
					.then(this.log("triggered enable off"))
			}

		} catch (err) {
			//this.setUnavailable();
			Homey.app.updateLog(this.getName() + " onCapabilityOnoff Error " + JSON.stringify(err, null, 2), true);
		}
	}

	async setupImages() {
		try {
			const snapURL = await Homey.app.getSnapshotURL(this.cam);

			const devData = this.getData();

			const settings = this.getSettings();
			const publicSnapURL = snapURL.uri.replace(settings.password, "YOUR_PASSWORD");
			Homey.app.updateLog("SnapShot URL = " + publicSnapURL);

			await this.setSettings({
					"ip": devData.id,
					"port": devData.port.toString(),
					"url": publicSnapURL
				})

			if (settings.hasMotion) {
				const imageFilename = 'eventImage' + devData.id;
				this.eventImageFilename = imageFilename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
				this.eventImageFilename += ".jpg";
				Homey.app.updateLog("SnapShot save file = " + this.eventImageFilename);

				const eventImagePath = Homey.app.getUserDataPath(this.eventImageFilename);
				if (!fs.existsSync(eventImagePath)) {
					Homey.app.updateLog("Initialising event image");
					// Initialise the event image with the current snapshot
					const storageStream = fs.createWriteStream(eventImagePath);
					const res = await fetch(snapURL.uri);
					if (!res.ok) throw new Error(res.statusText);
					res.body.pipe(storageStream);
					storageStream.on('error', function (err) {
						Homey.app.updateLog(JSON.stringify(err, null, 2));
					});
				}

				if (!this.eventImage) {
					this.eventImage = new Homey.Image();
					this.eventImage.setPath(eventImagePath);
					this.eventImage.register()
						.then(() => {
							Homey.app.updateLog("register")
							this.setCameraImage('Event', 'Motion Event', this.eventImage);
						})
						.catch(this.error);
				}
			}

			if (!this.nowImage) {
				this.nowImage = new Homey.Image();
				this.nowImage.setStream(async (stream) => {
					const res = await fetch(snapURL.uri);
					if (!res.ok) throw new Error(res.statusText);
					res.body.pipe(stream);
				});

				this.nowImage.register()
					.then(() => {
						this.setCameraImage('Now', 'Now', this.nowImage);
					})
					.catch(this.error);
			}
		} catch (err) {
			Homey.app.updateLog("SnapShot error: " + JSON.stringify(err, null, 2), true);
		}
	}

	onDeleted() {
		try {
			if (this.cam) {
				this.cam.removeAllListeners('event');
			}
			clearTimeout(this.checkTimerId);
		} catch (err) {
			console.log("Delete device error", err);
		}
	}
}

module.exports = CameraDevice;