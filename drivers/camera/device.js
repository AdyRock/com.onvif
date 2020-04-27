'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const fs = require('fs');

class CameraDevice extends Homey.Device {

	async onInit() {
		Homey.app.updateLog("Initialising CameraDevice");
		this.repairing = false;
		this.cam = null;
		this.eventImage = null;
		this.nowImage = null;
		this.eventTime = this.getStoreValue('eventTime');
		this.alarmTime = this.getStoreValue('alarmTime');
		this.cameraTime = null;

		// Upgrade old device settings where the ip and port where part of the data
		const settings = this.getSettings();
		if (!settings.ip) {
			const devData = this.getData();
			await this.setSettings({
				'ip': devData.id,
				'port': devData.port.toString()
			})
		}

		this.connectCamera(false)
			.catch(err => {
				Homey.app.updateLog("Check Camera Error: " + Homey.app.varToString(err), true);
			});

		this.registerCapabilityListener('motion_enabled', this.onCapabilityMotionEnable.bind(this));

		this.motionEnabledTrigger = new Homey.FlowCardTriggerDevice('motionEnabledTrigger');
		this.motionEnabledTrigger.register();

		this.motionDisabledTrigger = new Homey.FlowCardTriggerDevice('motionDisabledTrigger');
		this.motionDisabledTrigger.register();

		this.snapshotReadyTrigger = new Homey.FlowCardTriggerDevice('snapshotReadyTrigger');
		this.snapshotReadyTrigger.register();

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
						Homey.app.updateLog("Check Camera Error: " + Homey.app.varToString(err), true);
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
				// refresh image settings after exiting this callback
				setTimeout(this.setupImages().bind(this), 2000);
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

		if (changedKeysArr.indexOf("userSnapUrl") >= 0) {
			// refresh image settings after exiting this callback
			this.setupImages = this.setupImages.bind(this);
			setTimeout(this.setupImages, 2000);
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

				this.cam.on('error', function (msg, xml) {
					Homey.app.updateLog("Camera event error: " + Homey.app.varToString(msg), true);
					if (xml) {
						Homey.app.updateLog("xml: " + Homey.app.varToString(xml));
					}
				}.bind(this));

				if (addingCamera) {
					let info = {};
					try {
						info = await Homey.app.getDeviceInformation(this.cam);
						Homey.app.updateLog("Camera Information: " + Homey.app.varToString(info, ));
					} catch (err) {
						Homey.app.updateLog("Get camera info error: " + err.stack, true);
					}

					let supportedEvents = [""];
					try {
						let capabilities = await Homey.app.getCapabilities(this.cam);
						let hasEvents = Homey.app.hasPullSupport(capabilities);
						if (hasEvents) {
							supportedEvents = await Homey.app.hasEventTopics(this.cam);
						}
					} catch (err) {
						Homey.app.updateLog("Get camera capabilities error: " + err.stack, true);
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
					}
					addingCamera = false;
				}
				await this.setupImages();

				if (settings.hasMotion) {
					if (this.getCapabilityValue('motion_enabled')) {
						// Motion detection is enabled so listen for events
						this.listenForEvents(this.cam);
					}
				}

				this.setAvailable();
				this.checkCamera = this.checkCamera.bind(this);
				this.checkTimerId = setTimeout(this.checkCamera, 10000);
				this.setCapabilityValue('alarm_tamper', false);
			} catch (err) {
				if (!this.repairing) {
					Homey.app.updateLog("Connect to camera error: " + err.stack, true);
					this.setUnavailable();
				}
				this.checkTimerId = setTimeout(this.connectCamera.bind(this, addingCamera), 2000);
				this.setCapabilityValue('alarm_tamper', false);
			}
		}
	}

	async checkCamera() {
		if (!this.repairing) {
			this.cam.getSystemDateAndTime(function (err, date, xml) {
				if (err) {
					err = String(err);
					Homey.app.updateLog("Check Camera Error: " + Homey.app.varToString(err), true);

					if (!this.getCapabilityValue('alarm_tamper')) {
						this.setCapabilityValue('alarm_tamper', true);
						this.alarmTime = new Date(Date.now());
						this.setStoreValue('alarmTime', this.alarmTime);
						this.setCapabilityValue('tamper_time', this.convertDate(this.alarmTime, this.getSettings()));
					}

					if (err.indexOf("EHOSTUNREACH") >= 0) {
						this.setUnavailable();
					}
				} else if (this.getCapabilityValue('alarm_tamper')) {
					Homey.app.updateLog("Check Camera: back online");
					this.setCapabilityValue('alarm_tamper', false);
					this.setAvailable();
				} else {
					this.cameraTime = date;
					this.setCapabilityValue('date_time', this.convertDate(this.cameraTime, this.getSettings()));
				}
			}.bind(this));
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

	async listenForEvents(cam_obj) {
		//Stop listening for motion events before we add a new listener
		this.cam.removeAllListeners('event');

		Homey.app.updateLog('######    Waiting for events   ######');
		var camSnapURL = await Homey.app.getSnapshotURL(this.cam);
		const eventImage = this.eventImage;

		cam_obj.on('event', async (camMessage, xml) => {
			try {
				Homey.app.updateLog('------    Event detected   ------');
				Homey.app.updateLog(Homey.app.varToString(camMessage));

				this.setAvailable();

				let eventTopic = camMessage.topic._
				eventTopic = Homey.app.stripNamespaces(eventTopic)
				Homey.app.updateLog(Homey.app.varToString(eventTopic));

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

								if (camSnapURL.invalidAfterConnect) {
									await Homey.app.getSnapshotURL(this.cam);
								}

								Homey.app.updateLog("Event snapshot URL: " + Homey.app.varToString(this.snapUri).replace(settings.password, "YOUR_PASSWORD"));

								const res = await fetch(this.snapUri);
								if (!res.ok) throw new Error(res.statusText);
								res.body.pipe(storageStream);
								storageStream.on('error', function (err) {
									Homey.app.updateLog(Homey.app.varToString(err));
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
				Homey.app.updateLog("Camera Event Error: " + err.stack, true);
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
			Homey.app.updateLog(this.getName() + " onCapabilityOnoff Error " + err.stack, true);
		}
	}

	async setupImages() {
		try {
			const devData = this.getData();
			const settings = this.getSettings();

			var invalidAfterConnect = false;
			this.snapUri = settings.userSnapUrl;
			if (this.snapUri === "") {
				// Use ONVIF snapshot URL
				const snapURL = await Homey.app.getSnapshotURL(this.cam);
				this.snapUri = snapURL.uri;
				invalidAfterConnect = snapURL.invalidAfterConnect;

				const publicSnapURL = this.snapUri.replace(settings.password, "YOUR_PASSWORD");
				await this.setSettings({
					"url": publicSnapURL
				})
			} else {
				// Use user specified snapshot URI
				this.snapUri = this.snapUri.replace("#PASSWORD#", settings.password);
				this.snapUri = this.snapUri.replace("#USERNAME#", settings.username);
			}

			Homey.app.updateLog("Snapshot URL: " + Homey.app.varToString(this.snapUri).replace(settings.password, "YOUR_PASSWORD"));

			try {
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
						Homey.app.updateLog("Fetching event image");

						if (invalidAfterConnect) {
							// Suggestions on the internet say this has to be called before getting the snapshot if invalidAfterConnect = true
							await Homey.app.getSnapshotURL(this.cam)
						}
						const res = await fetch(this.snapUri, {
							headers: {'Authorization': 'Basic ' + Buffer.from(settings.username + ":" + settings.password).toString('base64')}
						});
						
						if (!res.ok) throw new Error(res.statusText);
						res.body.pipe(storageStream);

						storageStream.on('error', function (err) {
							Homey.app.updateLog("Fetch event image error: " + err.stack, true);
						});
					}

					if (!this.eventImage) {
						Homey.app.updateLog("Registering event image");
						this.eventImage = new Homey.Image();
						this.eventImage.setPath(eventImagePath);
						this.eventImage.register()
							.then(() => {
								Homey.app.updateLog("registered event image")
								this.setCameraImage('Event', 'Motion Event', this.eventImage);
							})
							.catch((err) => {
								Homey.app.updateLog("Register event image error: " + err.stack, true);
							});
					}
				}
			} catch (err) {
				Homey.app.updateLog("Event SnapShot error: " + err.stack, true);
			}

			if (!this.nowImage) {
				Homey.app.updateLog("Registering now image");
				this.nowImage = new Homey.Image();
				this.nowImage.setStream(async (stream) => {
					if (invalidAfterConnect) {
						await Homey.app.getSnapshotURL(this.cam)
					}

					console.log("Snap URI: ", this.snapUri);

					const res = await fetch(this.snapUri, {
						headers: {'Authorization': 'Basic ' + Buffer.from(settings.username + ":" + settings.password).toString('base64')}
					});

					if (!res.ok) throw new Error(res.statusText);
					res.body.pipe(stream);
				});

				this.nowImage.register()
					.then(() => {
						Homey.app.updateLog("registered now image")
						this.setCameraImage('Now', 'Now', this.nowImage);
					})
					.catch((err) => {
						Homey.app.updateLog("Register now image error: " + err.stack, true);
					});
			}
		} catch (err) {
			//Homey.app.updateLog("SnapShot error: " + Homey.app.varToString(err), true);
			Homey.app.updateLog("SnapShot error: " + err.stack, true);
		}
	}

	onDeleted() {
		try {
			if (this.cam) {
				this.cam.removeAllListeners('event');
			}
			clearTimeout(this.checkTimerId);

			if (this.eventImageFilename) {
				const eventImagePath = Homey.app.getUserDataPath(this.eventImageFilename);
				if (!fs.existsSync(eventImagePath)) {
					fs.unlink(eventImagePath, (err) => {
						if (!err) {
							console.log('successfully deleted: ', this.eventImageFilename);
						}
					});
				}
			}
		} catch (err) {
			console.log("Delete device error", err);
		}
	}
}

module.exports = CameraDevice;