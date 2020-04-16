'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
var fs = require('fs');

class CameraDevice extends Homey.Device {

	onInit() {
		this.cam = null;
		this.log('CameraDevice has been inited');

		this.connectCamera();
		this.registerCapabilityListener('motion_enabled', this.onCapabilityMotionEnable.bind(this));

		this.motionEnabledTrigger = new Homey.FlowCardTriggerDevice('motionEnabledTrigger');
		this.motionEnabledTrigger.register();

		this.motionDisabledTrigger = new Homey.FlowCardTriggerDevice('motionDisabledTrigger');
		this.motionDisabledTrigger.register();

		this.registerCapabilityListener('button.syncTime', async () => {
			// Set the Camera date to Homey's date
			console.log("Syncing time");

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
						console.log("Check Camera Error: ", err);
					}
				}.bind(this));
		});
	}

	async onAdded() {
		this.log('CameraDevice has been added');
		await this.getDriver().getLastCredentials(this);
		this.connectCamera();
	}

	async connectCamera() {
		const devData = this.getData();
		this.log("Dev Data: ", devData);
		const settings = this.getSettings();

		if (this.getStoreValue('initialised')) {
			try {
				this.log("Connecting to camera");
				this.cam = await Homey.app.connectCamera(
					devData.id,
					devData.port,
					settings.username,
					settings.password
				);

				console.log("Camera connected");
				await this.setupImages();

				if (!devData.hasMotion) {
					if (this.hasCapability('motion_enabled')) {
						this.removeCapability('motion_enabled');
					}

					if (this.hasCapability('alarm_motion')) {
						this.removeCapability('alarm_motion');
					}
				} else {

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
				this.log("Connect to camera error: ", err);
				this.setUnavailable();
				this.connectCamera = this.connectCamera.bind(this);
				setTimeout(this.connectCamera, 10000);
			}
		} else {
			this.log("Device not ready");
		}
	}

	async checkCamera() {
		this.cam.getSystemDateAndTime(function (err, date, xml) {
			if (err) {
				err = String(err);
				console.log("Check Camera Error: ", err);
				if (err.indexOf("EHOSTUNREACH") >= 0) {
					this.setUnavailable();
				} else if (err.indexOf("Network timeout") >= 0) {
					if (!this.getCapabilityValue('alarm_tamper')) {
						this.setCapabilityValue('alarm_tamper', true);
						var d = new Date(Date.now());
						var date = d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes() + ":" + (d.getSeconds() < 10 ? "0" : "") + d.getSeconds() + " " + (d.getDate() < 10 ? "0" : "") + d.getDate() + "-" + (d.getMonth() < 10 ? "0" : "") + d.getMonth();
						this.setCapabilityValue('tamper_time', date);
					}
				}
			} else if (this.getCapabilityValue('alarm_tamper')) {
				this.setCapabilityValue('alarm_tamper', false);
				this.setAvailable();
			} else {
				var d = new Date(date);
				date = d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes() + ":" + (d.getSeconds() < 10 ? "0" : "") + d.getSeconds() + " " + (d.getDate() < 10 ? "0" : "") + d.getDate() + "-" + (d.getMonth() < 10 ? "0" : "") + d.getMonth();
				this.setCapabilityValue('date_time', date);
			}
		}.bind(this));

		this.checkCamera = this.checkCamera.bind(this);
		this.checkTimerId = setTimeout(this.checkCamera, this.getCapabilityValue('alarm_tamper') ? 10000 : 1000);
	}

	async listenForEvents(cam_obj) {
		//Stop listening for motion events before we add a new listener
		this.cam.removeAllListeners('event');

		console.log('#############################    Waiting for events   ######################');
		const camSnapPath = await Homey.app.getSnapshotURL(this.cam);
		const eventImage = this.eventImage;
		const settings = this.getSettings();

		cam_obj.on('event', async (camMessage, xml) => {
			try {
				//console.log('----------------    Event detected   -----------------------');
				// console.log(camMessage);

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
					console.log("WARNING: Data contain an elementItem")
					dataName = 'elementItem'
					dataValue = JSON.stringify(camMessage.message.message.data.elementItem)
				} else {
					console.log("WARNING: Data does not contain a simpleItem or elementItem")
					dataName = null
					dataValue = null
				}

				if (dataName) {
					console.log("Event ", dataName, " = ", dataValue);
					if (dataName === "IsMotion") {
						if (!settings.single || dataValue != this.getCapabilityValue('alarm_motion')) {
							console.log("Event Processing", dataName, " = ", dataValue);
							this.setCapabilityValue('alarm_motion', dataValue);
							if (dataValue) {
								var d = new Date(Date.now());
								var date = d.getHours() + ":" + (d.getMinutes() < 10 ? "0" : "") + d.getMinutes() + ":" + (d.getSeconds() < 10 ? "0" : "") + d.getSeconds() + " " + (d.getDate() < 10 ? "0" : "") + d.getDate() + "-" + (d.getMonth() < 10 ? "0" : "") + d.getMonth();
								this.setCapabilityValue('event_time', date);
								if (settings.delay > 0) {
									await new Promise(resolve => setTimeout(resolve, settings.delay * 1000));
								}
								const storageStream = fs.createWriteStream(Homey.app.getUserDataPath(this.eventImageFilename));
								const res = await fetch(camSnapPath.uri);
								if (!res.ok) throw new Error(res.statusText);
								res.body.pipe(storageStream);
								storageStream.on('error', function (err) {
									console.log(err);
								})
								storageStream.on('finish', function () {
									eventImage.update();
									console.log("Event Image Updated");
								});
							}
						}
					}
				}
			} catch (err) {
				console.log("Camera Event Error: ", err);
			}
		})
	}

	async onCapabilityMotionEnable(value, opts) {
		try {
			console.log("Switch motion detection On/Off: ", value);
			this.setCapabilityValue('alarm_motion', false);
			const devData = this.getData();

			if (value && devData.hasMotion) {
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
			console.log(this.getName(), " onCapabilityOnoff Error ", err);
		}
	}

	async setupImages() {
		try {
			const snapURL = await Homey.app.getSnapshotURL(this.cam);
			console.log("SnapShot URL = ", snapURL.uri);
			const devData = this.getData();

			const imageFilename = 'eventImage' + devData.id;
			this.eventImageFilename = imageFilename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
			this.eventImageFilename += ".jpg";
			console.log("SnapShot save file = ", this.eventImageFilename);

			const eventImagePath = Homey.app.getUserDataPath(this.eventImageFilename);
			if (!fs.existsSync(eventImagePath)) {
				console.log("Initialising event image");
				// Initialise the event image with the current snapshot
				const storageStream = fs.createWriteStream(eventImagePath);
				const res = await fetch(snapURL.uri);
				if (!res.ok) throw new Error(res.statusText);
				res.body.pipe(storageStream);
				storageStream.on('error', function (err) {
					console.log(err);
				});
			}

			this.eventImage = new Homey.Image();
			this.eventImage.setPath(eventImagePath);
			this.eventImage.register()
				.then(() => {
					console.log("register")
					this.setCameraImage('Event', 'Motion Event', this.eventImage);
				})
				.catch(this.error);



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
		} catch (err) {
			console.log("SnapShot error: ", err);
		}
	}

	onDeleted() {
		this.cam.removeAllListeners('event');
		clearTimeout(this.checkTimerId);
	}
}

module.exports = CameraDevice;