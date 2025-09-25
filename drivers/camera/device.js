/* eslint-disable no-unused-vars */
/*jslint node: true */
'use strict';

const Homey = require('homey');
const DigestFetch = require('digest-fetch');
const fetch = require('node-fetch');
const https = require('https');
const http = require('http');
const fs = require('fs');

const notificationMap = {
	'RuleEngine/CellMotionDetector/Motion:IsMotion': ['MOTION'],
	'RuleEngine/FieldDetector/ObjectsInside:IsInside': ['ANALYTICSSERVICE', 'OBJECTSINSIDE'],
	'VideoSource/MotionAlarm:State': ['MOTIONALARM'],
	'Device/Trigger/DigitalInput:LogicalState': ['DIGITALINPUT']
};

class CameraDevice extends Homey.Device
{
	async onInit()
	{
		this.repairing = false;
		this.connecting = false;
		this.isReady = false;
		this.updatingEventImage = false;
		this.cam = null;
		this.eventImage = null;
		this.nowImage = null;
		this.eventTime = this.getStoreValue('eventTime');
		this.alarmTime = this.getStoreValue('alarmTime');
		this.cameraTime = null;
		this.authType = 0;
		this.snapshotSupported = true;
		this.eventMinTimeId = null;
		this.checkTimerId = null;
		this.eventTimerId = null;
		this.video = null;

		this.connectCamera.bind(this);

		// Upgrade old device settings where the ip and port where part of the data
		const settings = this.getSettings();
		const devData = this.getData();
		if (typeof settings.ip === 'undefined')
		{
			await this.setSettings(
				{
					'ip': devData.id,
					'port': devData.port.toString()
				});
		}

		this.preferPullEvents = settings.preferPullEvents;
		this.hasMotion = settings.hasMotion;
		if (typeof settings.channel === 'undefined')
		{
			await this.setSettings(
				{
					'channel': -1
				});
		}

		if (typeof settings.token === 'undefined')
		{
			await this.setSettings(
				{
					'token': ''
				});
		}

		if (typeof settings.utc_time === 'undefined')
		{
			await this.setSettings(
				{
					'utc_time': false
				});
		}

		this.cameraEnabled = settings.enabled;
		this.password = settings.password;
		this.username = settings.username;
		this.ip = settings.ip;
		this.port = settings.port;
		this.channel = settings.channel;
		this.token = settings.token;
		this.userSnapUri = settings.userSnapUri;
		this.eventTN = this.getEventTN(settings, false);
		this.eventObjectID = settings.objectID;
		if (this.eventTN !== 'RuleEngine/FieldDetector/ObjectsInside:IsInside')
		{
			this.eventObjectID = '';
		}
		else if (this.eventObjectID !== '')
		{
			this.eventObjectID = this.eventObjectID.split(',');
		}

		this.id = devData.id;
		this.name = this.getName();
		this.homey.app.updateLog('Initialising CameraDevice (' + this.name + ')');

		if (this.hasCapability('alarm_motion'))
		{
			this.setCapabilityValue('alarm_motion', false).catch(this.error);
		}

		let requiredClass = settings.classType;
		if (this.getClass() != requiredClass)
		{
			this.setClass(requiredClass);
		}

		this.checkTimerId = this.homey.setTimeout(() =>
		{
			this.checkTimerId = null;
			this.setUnavailable('Initialising system. Please wait...').catch(this.err);
		}, 500);

		// this.connectCamera(false)
		//     .catch(err =>
		//     {
		//         this.homey.app.updateLog('Check Camera Error (' + this.name + '): ' + this.homey.app.varToString(err.message), 0);
		//     });

		if (this.hasCapability('ptz_preset'))
		{
			this.registerCapabilityListener('ptz_preset', this.onCapabilityPTZPreset.bind(this));
		}

		this.registerCapabilityListener('motion_enabled', this.onCapabilityMotionEnable.bind(this));
		this.registerCapabilityListener('button.syncTime', async () =>
		{
			// Set the Camera date to Homey's date
			this.homey.app.updateLog('Syncing time (' + this.name + ')');

			Date.prototype.stdTimezoneOffset = function ()
			{
				let jan = new Date(this.getFullYear(), 0, 1);
				let jul = new Date(this.getFullYear(), 6, 1);
				return Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
			};

			Date.prototype.isDstObserved = function ()
			{
				return this.getTimezoneOffset() < this.stdTimezoneOffset();
			};

			try
			{
				let d = new Date();
				let dls = d.isDstObserved();

				this.cam.setSystemDateAndTime(
					{
						'dateTime': d,
						'dateTimeType': 'Manual',
						'daylightSavings': dls
					},
					(err, date, xml) =>
					{
						if (err)
						{
							this.homey.app.updateLog('Check Camera Error (' + this.name + '): ' + this.homey.app.varToString(err), 0);
						}
					});
			}
			catch (err)
			{
				this.homey.app.updateLog('Check Camera Error (' + this.name + '): ' + this.homey.app.varToString(err), 0);
			}
		});
	}

	async onAdded()
	{
		this.homey.app.updateLog('CameraDevice has been added (' + this.name + ')');
		this.setCapabilityValue('motion_enabled', false).catch(this.err);
	}

	notificationTypesUpdated(settings)
	{
		// Check if the notification types are enabled in the settings and add/remove capabilities accordingly
		//		if (notificationTypes.indexOf('CROSSED') >= 0)
		if (settings.line_crossed === true)
		{
			if (!this.hasCapability('alarm_line_crossed'))
			{
				this.addCapability('alarm_line_crossed')
					.then(() =>
					{
						this.setCapabilityValue('alarm_line_crossed', false).catch(this.error);
					})
					.catch(this.error);
			}
		}
		else
		{
			if (this.hasCapability('alarm_line_crossed'))
			{
				this.removeCapability('alarm_line_crossed').catch(this.error);
			}
		}

		//		if (notificationTypes.indexOf('PERSON') >= 0)
		if (settings.person === true)
		{
			if (!this.hasCapability('alarm_person'))
			{
				this.addCapability('alarm_person')
					.then(() =>
					{
						this.setCapabilityValue('alarm_person', false).catch(this.error);
					})
					.catch(this.error);
			}
		}
		else
		{
			if (this.hasCapability('alarm_person'))
			{
				this.removeCapability('alarm_person').catch(this.error);
			}
		}

		if (settings.visitor === true)
		{
			if (!this.hasCapability('alarm_visitor'))
			{
				this.addCapability('alarm_visitor')
					.then(() =>
					{
						this.setCapabilityValue('alarm_visitor', false).catch(this.error);
					})
					.catch(this.error);
			}
		}
		else
		{
			if (this.hasCapability('alarm_visitor'))
			{
				this.removeCapability('alarm_visitor').catch(this.error);
			}
		}

		if (settings.face === true)
		{
			if (!this.hasCapability('alarm_face'))
			{
				this.addCapability('alarm_face')
					.then(() =>
					{
						this.setCapabilityValue('alarm_face', false).catch(this.error);
					})
					.catch(this.error);
			}
		}
		else
		{
			if (this.hasCapability('alarm_face'))
			{
				this.removeCapability('alarm_face').catch(this.error);
			}
		}

		if (settings.dog_cat === true)
		{
			if (!this.hasCapability('alarm_dog_cat'))
			{
				this.addCapability('alarm_dog_cat')
					.then(() =>
					{
						this.setCapabilityValue('alarm_dog_cat', false).catch(this.error);
					})
					.catch(this.error);
			}
		}
		else
		{
			if (this.hasCapability('alarm_dog_cat'))
			{
				this.removeCapability('alarm_dog_cat').catch(this.error);
			}
		}

		if (settings.vehicle === true)
		{
			if (!this.hasCapability('alarm_vehicle'))
			{
				this.addCapability('alarm_vehicle')
					.then(() =>
					{
						this.setCapabilityValue('alarm_vehicle', false).catch(this.error);
					})
					.catch(this.error);
			}
		}
		else
		{
			if (this.hasCapability('alarm_vehicle'))
			{
				this.removeCapability('alarm_vehicle').catch(this.error);
			}
		}

		//		if (notificationTypes.indexOf('IMAGINGSERVICE') >= 0)
		if (settings.dark_image === true)
		{
			if (!this.hasCapability('alarm_dark_image'))
			{
				this.addCapability('alarm_dark_image')
					.then(() =>
					{
						this.setCapabilityValue('alarm_dark_image', false).catch(this.error);
					})
					.catch(this.error);
			}
		}
		else
		{
			if (this.hasCapability('alarm_dark_image'))
			{
				this.removeCapability('alarm_dark_image').catch(this.error);
			}
		}

		//		if (notificationTypes.indexOf('STORAGEFAILURE') >= 0)
		if (settings.storage === true)
		{
			if (!this.hasCapability('alarm_storage'))
			{
				this.addCapability('alarm_storage')
					.then(() =>
					{
						this.setCapabilityValue('alarm_storage', false).catch(this.error);
					})
					.catch(this.error);
			}
		}
		else
		{
			if (this.hasCapability('alarm_storage'))
			{
				this.removeCapability('alarm_storage').catch(this.error);
			}
		}

		//		if (notificationTypes.indexOf('PROCESSORUSAGE') >= 0)
		if (settings.cpu === true)
		{
			if (!this.hasCapability('measure_cpu'))
			{
				this.addCapability('measure_cpu')
					.then(() =>
					{
						this.setCapabilityValue('measure_cpu', 0).catch(this.error);
					})
					.catch(this.error);
			}
		}
		else
		{
			if (this.hasCapability('measure_cpu'))
			{
				this.removeCapability('measure_cpu').catch(this.error);
			}
		}

		//		if (notificationTypes.indexOf('DETECTEDSOUND') >= 0)
		if (settings.sound === true)
		{
			if (!this.hasCapability('alarm_sound'))
			{
				this.addCapability('alarm_sound')
					.then(() =>
					{
						this.setCapabilityValue('alarm_sound', 0).catch(this.error);
					})
					.catch(this.error);
			}
		}
		else
		{
			if (this.hasCapability('alarm_sound'))
			{
				this.removeCapability('alarm_sound').catch(this.error);
			}
		}

	}

	getEventTN(settings, fromSetSettings)
	{
		const searchType = notificationMap[settings.notificationToUse];
		const availableTypes = settings.notificationTypes.split(',');

		// See if the required type is available
		if (availableTypes.map(function (type) { return searchType.indexOf(type); }))
		//        if (availableTypes.indexOf(searchType) >= 0)
		{
			return settings.notificationToUse;
		}

		if (fromSetSettings)
		{
			throw (new Error('Sorry the notification method you have chosen to use is not supported by this camera.'));
		}

		// Not available so try MOTION
		if (availableTypes.indexOf('MOTION') >= 0)
		{
			return 'RuleEngine/CellMotionDetector/Motion:IsMotion';
		}

		return 'VideoSource/MotionAlarm:State';
	}

	async onRenamed(newName)
	{
		this.name = newName;
	}

	async onSettings({ oldSettings, newSettings, changedKeys })
	{
		let reconnect = false;

		if (changedKeys.indexOf('notificationToUse') >= 0)
		{
			this.eventTN = this.getEventTN(newSettings, true);
		}

		if (changedKeys.indexOf('token') >= 0)
		{
			this.token = newSettings.token;
		}

		if (changedKeys.indexOf('objectID') >= 0)
		{
			this.eventObjectID = newSettings.objectID;
		}
		else
		{
			this.eventObjectID = oldSettings.objectID;
		}

		if (this.eventTN !== 'RuleEngine/FieldDetector/ObjectsInside:IsInside')
		{
			this.eventObjectID = '';
		}
		else if (this.eventObjectID !== '')
		{
			this.eventObjectID = this.eventObjectID.split(',');
		}

		if (changedKeys.indexOf('enabled') >= 0)
		{
			this.cameraEnabled = newSettings.enabled;
			reconnect = true;
		}

		if (changedKeys.indexOf('username') >= 0)
		{
			this.username = newSettings.username;
			if (this.video)
			{
				// Disconnect the video stream so it can be reconnected
				this.homey.videos.unregisterVideo(this.video);
				this.video = null;
			}
			reconnect = true;
		}

		if (changedKeys.indexOf('password') >= 0)
		{
			this.password = newSettings.password;
			if (this.video)
			{
				// Disconnect the video stream so it can be reconnected
				this.homey.videos.unregisterVideo(this.video);
				this.video = null;
			}
			reconnect = true;
		}

		if (changedKeys.indexOf('ip') >= 0)
		{
			// Switch off the current event mode
			this.clearTimers();
			await this.homey.app.unsubscribe(this);

			this.ip = newSettings.ip;
			if (this.video)
			{
				// Disconnect the video stream so it can be reconnected
				this.homey.videos.unregisterVideo(this.video);
				this.video = null;
			}
			reconnect = true;
		}

		if (changedKeys.indexOf('port') >= 0)
		{
			this.port = newSettings.port;
			reconnect = true;
		}

		if ((changedKeys.indexOf('timeFormat') >= 0) || (changedKeys.indexOf('offset_time') >= 0) || (changedKeys.indexOf('utc_time') >= 0))
		{
			this.setCapabilityValue('event_time', this.convertDate(this.eventTime, newSettings, false)).catch(this.error);
			this.setCapabilityValue('tamper_time', this.convertDate(this.alarmTime, newSettings, false)).catch(this.error);
			this.setCapabilityValue('date_time', this.convertDate(this.cameraTime, newSettings, true)).catch(this.error);
		}

		if (changedKeys.indexOf('channel') >= 0)
		{
			this.channel = newSettings.channel;
			if (!reconnect)
			{
				// refresh image settings after exiting this callback
				setImmediate(() =>
				{
					this.setupImages().catch(this.error);
					return;
				});
			}
		}

		if (changedKeys.indexOf('hasSnapshot') >= 0)
		{
			this.snapshotSupported = newSettings.hasSnapshot;
		}

		if (changedKeys.indexOf('userSnapUri') >= 0)
		{
			this.userSnapUri = newSettings.userSnapUri;
			if (!reconnect)
			{
				// refresh image settings after exiting this callback
				setImmediate(() =>
				{
					this.setupImages().catch(this.error);
					return;
				});
			}
		}

		if (changedKeys.indexOf('preferPullEvents') >= 0)
		{
			// Changing preferred event method
			this.preferPullEvents = newSettings.preferPullEvents;
			if (this.hasMotion && this.getCapabilityValue('motion_enabled'))
			{
				// Switch off the current even mode
				try
				{
					await this.homey.app.unsubscribe(this);
				}
				catch (err)
				{
					this.homey.app.updateLog('unsubscribe error (' + this.name + '): ' + this.homey.app.varToString(err.mesage), 0);
				}

				if (!reconnect)
				{
					// Turn on the new mode
					setImmediate(() =>
					{
						this.listenForEvents(this.cam).catch(this.error);
						return;
					});
				}
			}
		}

		if (changedKeys.indexOf('classType') >= 0)
		{
			this.setClass(newSettings.classType);
		}

		if ((changedKeys.indexOf('line_crossed') >= 0) ||
		    (changedKeys.indexOf('person') >= 0) ||
			(changedKeys.indexOf('visitor') >= 0) ||
			(changedKeys.indexOf('face') >= 0) ||
			(changedKeys.indexOf('dog_cat') >= 0) ||
			(changedKeys.indexOf('vehicle') >= 0) ||
			(changedKeys.indexOf('dark_image') >= 0) ||
			(changedKeys.indexOf('storage') >= 0) ||
			(changedKeys.indexOf('cpu') >= 0) ||
			(changedKeys.indexOf('sound') >= 0))
		{
			this.notificationTypesUpdated(newSettings);
		}

		if (reconnect)
		{
			// re-connect to camera after exiting this callback
			setImmediate(() =>
			{
				this.connectCamera(false).catch(this.error).catch(this.error);
				return;
			});
		}
	}

	async connectCamera()
	{
		if (!this.cameraEnabled)
		{
			if (this.cam)
			{
				this.clearTimers();
				if (this.cam)
				{
					//Stop listening for motion events
					this.cam.removeAllListeners('event');

					try
					{
						await this.homey.app.unsubscribe(this);
					}
					catch (err)
					{
						this.homey.app.updateLog('unsubscribe error (' + this.name + '): ' + this.homey.app.varToString(err.mesage), 0);
					}
				}
				this.cam = null;
			}

			this.setUnavailable('Camera is disabled in Advanced Settings').catch(this.err);

			return;
		}
		if (this.checkTimerId)
		{
			// Camera connect timer is running so allow that to happen
			return;
		}

		if (this.repairing)
		{
			// Wait while repairing and try again later
			this.clearTimers();
		}
		else
		{
			this.connecting = true;
			try
			{
				this.cam = await this.homey.app.connectCamera(
					this.ip,
					this.port,
					this.username,
					this.password
				);

				this.cam.on('error', (msg, xml) =>
				{
					this.homey.app.updateLog('Global Camera event error (' + this.name + '): ' + this.homey.app.varToString(msg), 0);
					if (xml)
					{
						this.homey.app.updateLog('xml: ' + this.homey.app.varToString(xml), 3);
					}
				});

				this.supportPushEvent = false;
				try
				{
					if (this.channel > 0)
					{
						this.cam.setActiveSource(this.channel - 1);
					}

					let capabilities = await this.homey.app.getServiceCapabilities(this.cam);
					this.homey.app.updateLog('** service capabilities ' + this.name + ' = ' + this.homey.app.varToString(capabilities));

					let services = await this.homey.app.getServices(this.cam);
					if (Array.isArray(services))
					{
						services.forEach((service) =>
						{
							this.homey.app.updateLog('** Service ' + this.name + this.homey.app.varToString(service));
							if (service.namespace.search('.org/') > 0)
							{
								let namespaceSplitted = service.namespace.split('.org/')[1].split('/');
								if ((namespaceSplitted[1] == 'events') && service.capabilities && service.capabilities.capabilities)
								{
									let serviceCapabilities = service.capabilities.capabilities.$;
									if ((serviceCapabilities.MaxNotificationProducers > 0) || (serviceCapabilities.WSSubscriptionPolicySupport === true))
									{
										this.supportPushEvent = true;
										this.homey.app.updateLog('** PushEvent supported on ' + this.name);
									}
								}
								if ((namespaceSplitted[1] == 'media') && service.capabilities && service.capabilities.capabilities)
								{
									let serviceCapabilities = service.capabilities.capabilities.$;
									if (serviceCapabilities.SnapshotUri >= 0)
									{
										this.snapshotSupported = serviceCapabilities.SnapshotUri;
										if (this.snapshotSupported)
										{
											this.homey.app.updateLog('** Snapshots are supported on ' + this.name);
										}
										else
										{
											this.homey.app.updateLog('** Snapshots NOT supported on ' + this.name, this.snapshotSupported, 0);
										}
									}
								}
								if (namespaceSplitted[1] == 'analytics')
								{
									this.supportPushEvent = true;
									this.homey.app.updateLog('** Analytics supported on ' + this.name);
								}
							}
							else
							{
								this.homey.app.updateLog('getServices: Unrecognised namespace for service ' + service);
							}
						});
					}
				}
				catch (err)
				{
					this.homey.app.updateLog('Get camera services error (' + this.name + '): ' + err.message, 0);
				}

				let info = {};
				try
				{
					info = await this.homey.app.getDeviceInformation(this.cam);
					this.homey.app.updateLog('Camera Information (' + this.name + '): ' + this.homey.app.varToString(info,));
				}
				catch (err)
				{
					this.homey.app.updateLog('Get camera info error (' + this.name + '): ' + err.message, 0);
				}

				let supportedEvents = [''];
				try
				{
					let capabilities = await this.homey.app.getCapabilities(this.cam);
					this.hasPullPoints = this.homey.app.hasPullSupport(capabilities, this.name);
					if (this.hasPullPoints || this.supportPushEvent)
					{
						supportedEvents = await this.homey.app.hasEventTopics(this.cam);
					}
				}
				catch (err)
				{
					this.homey.app.updateLog('Get camera capabilities error (' + this.name + '): ' + err.message, 0);
				}
				this.homey.app.updateLog('Supported Events(' + this.name + '): ' + supportedEvents);

				let notificationMethods = '';
				if (this.supportPushEvent && this.hasPullPoints)
				{
					notificationMethods = this.homey.__('Push_Pull_Supported'); //"Push and Pull supported: ";
					if (this.preferPullEvents)
					{
						notificationMethods += this.homey.__('Using_Pull'); //"Using Pull";
					}
					else
					{
						notificationMethods += this.homey.__('Using_Push'); //"Using Push";
					}
				}
				else if (this.hasPullPoints)
				{
					notificationMethods += this.homey.__('Only_Pull_Supported'); //"Only Pull supported";
				}
				else if (this.supportPushEvent)
				{
					notificationMethods += this.homey.__('Only_Push_Supported'); // "Only Push supported";
				}
				else
				{
					notificationMethods = this.homey.__('Not_Supported'); //"Not supported";
				}

				this.hasMotion = (((supportedEvents.indexOf('MOTION') >= 0) || (supportedEvents.indexOf('MOTIONALARM') >= 0) || (supportedEvents.indexOf('DIGITALINPUT') >= 0)) && (this.hasPullPoints || this.supportPushEvent));
				try
				{
					await this.setSettings(
						{
							'manufacturer': info.manufacturer,
							'model': info.model,
							'serialNumber': info.serialNumber.toString(),
							'firmwareVersion': info.firmwareVersion.toString(),
							'hasMotion': this.hasMotion,
							'notificationMethods': notificationMethods,
							'notificationTypes': supportedEvents.toString(),
							'hasSnapshot': this.snapshotSupported,
						});
				}
				catch (err)
				{
					this.homey.app.updateLog('Connect to camera set settings error (' + this.name + '): ' + err.message, 0);
				}

				let settings = this.getSettings();
				this.notificationTypesUpdated(settings);

				if (!this.hasMotion)
				{
					this.homey.app.updateLog('Removing unsupported motion capabilities for ' + this.name);

					if (this.hasCapability('motion_enabled'))
					{
						this.removeCapability('motion_enabled').catch(this.err);
					}
					if (this.hasCapability('alarm_motion'))
					{
						this.removeCapability('alarm_motion').catch(this.err);
					}
					if (this.hasCapability('event_time'))
					{
						this.removeCapability('event_time').catch(this.err);
					}
				}
				else
				{
					if (!this.hasCapability('motion_enabled'))
					{
						this.addCapability('motion_enabled').catch(this.err);
					}
					if (!this.hasCapability('alarm_motion'))
					{
						this.addCapability('alarm_motion').catch(this.err);
					}
					if (!this.hasCapability('event_time'))
					{
						this.addCapability('event_time').catch(this.err);
					}
				}

				// Check available presets directly after connecting
				let presets = null;
				try
				{
					presets = await new Promise((resolve, reject) =>
					{
						this.cam.getPresets({}, (err, data) =>
						{
							if (err) reject(err);
							else resolve(data);
						});
					});

					if (presets && Object.keys(presets).length > 0)
					{
						// Presets are available, add capability if it doesn't exist
						if (!this.hasCapability('ptz_preset'))
						{
							await this.addCapability('ptz_preset');
							this.registerCapabilityListener('ptz_preset', this.onCapabilityPTZPreset.bind(this));
						}
						await this.updatePresets();
					} else
					{
						// No presets available, remove capability if it exists
						if (this.hasCapability('ptz_preset'))
						{
							await this.removeCapability('ptz_preset');
						}
					}
				}
				catch (err)
				{
					// Error while retrieving presets, remove capability
					if (this.hasCapability('ptz_preset'))
					{
						await this.removeCapability('ptz_preset');
					}
					this.homey.app.updateLog(`No PTZ presets (${this.name}): ${err.message}`, 0);
				}

				await this.setAvailable();

				await this.setupImages();

				if (this.hasMotion)
				{
					if (this.getCapabilityValue('motion_enabled'))
					{
						// Motion detection is enabled so listen for events
						this.listenForEvents(this.cam).catch(this.error);
					}
				}
				this.isReady = true;
				this.setCapabilityValue('alarm_tamper', false).catch(this.error);
				this.homey.app.updateLog('Camera (' + this.name + ') ' + this.homey.app.varToString(this.cam), 3);
				this.homey.app.updateLog('Camera (' + this.name + ') is ready');

				if (presets && Object.keys(presets).length > 0)
				{
					// Check available presets directly after connecting
					await this.updatePresets();
				}
			}
			catch (err)
			{
				if (!this.repairing)
				{
					this.homey.app.updateLog('Connect to camera error (' + this.name + '): ' + err.message, 0);
					this.setUnavailable(err).catch(this.err);
				}
				this.clearTimers();

				// this.setCapabilityValue('alarm_tamper', false).catch(this.error);
			}

			this.connecting = false;
		}
	}

	async checkCamera()
	{
		if (this.checkTimerId || this.connecting)
		{
			// Camera disbaled or connect timer is running so allow that to happen
			return;
		}

		if (!this.cam)
		{
			return this.connectCamera(false);
		}

		if (this.cameraEnabled && !this.repairing && this.isReady && (parseInt(this.homey.settings.get('logLevel')) < 2))
		{
			try
			{
				let date = await this.homey.app.getDateAndTime(this.cam);
				if (this.getCapabilityValue('alarm_tamper'))
				{
					this.homey.app.updateLog('Check Camera (' + this.name + '): back online', 1);
					this.setCapabilityValue('alarm_tamper', false).catch(this.error);
					this.setAvailable().catch(this.error);

					if (this.hasMotion && this.getCapabilityValue('motion_enabled'))
					{
						//Restart event monitoring
						await this.homey.app.unsubscribe(this);
						setImmediate(() =>
						{
							this.listenForEvents(this.cam).catch(this.error);
							return;
						});
					}
				}
				else
				{
					this.setAvailable().catch(this.error);
					this.cameraTime = date;
					this.setCapabilityValue('date_time', this.convertDate(this.cameraTime, this.getSettings(), true)).catch(this.error);

					if (!this.snapUri)
					{
						await this.setupImages();
					}
				}
			}
			catch (err)
			{
				let errStr = String(err);
				this.homey.app.updateLog('Check Camera Error (' + this.name + '): ' + this.homey.app.varToString(errStr), 0);

				if (!this.getCapabilityValue('alarm_tamper'))
				{
					this.setCapabilityValue('alarm_tamper', true).catch(this.error);
					this.alarmTime = new Date(Date.now());
					this.setStoreValue('alarmTime', this.alarmTime);
					this.setCapabilityValue('tamper_time', this.convertDate(this.alarmTime, this.getSettings(), false)).catch(this.error);
				}

				if (errStr.indexOf('EHOSTUNREACH') >= 0)
				{
					this.setUnavailable(err).catch(this.err);
					try
					{
						await this.homey.app.unsubscribe(this);
					}
					catch (err)
					{
						this.log(err);
					}
				}
			}
		}
	}

	convertTZ(date, tzString)
	{
		return new Date((typeof date === 'string' ? new Date(date) : date).toLocaleString('en-US', { timeZone: tzString }));
	}

	convertDate(date, settings, cameraTime)
	{
		let strDate = '';
		if (date)
		{
			const tz = this.homey.clock.getTimezone();

			let d = (!cameraTime || settings.utc_time) ? this.convertTZ(date, tz) : new Date(date);

			if (cameraTime && settings.offset_time !== 0)
			{
				d.setHours(d.getHours() + settings.offset_time);
			}

			if (settings.timeFormat == 'mm_dd')
			{
				let mins = d.getMinutes();
				let dte = d.getDate();
				let mnth = d.getMonth() + 1;
				strDate = d.getHours() + ':' + (mins < 10 ? '0' : '') + mins + ' ' + (dte < 10 ? '0' : '') + dte + '-' + (mnth < 10 ? '0' : '') + mnth;
			}
			else if (settings.timeFormat == 'system')
			{
				strDate = d.toLocaleString();
			}
			else
			{
				strDate = d.toJSON();
			}
		}

		return strDate;
	}

	async readEventImage()
	{
		if (this.invalidAfterConnect)
		{
			// Suggestions on the internet say this has to be called before getting the snapshot if invalidAfterConnect = true
			try
			{
				const snapURL = await this.homey.app.getSnapshotURL(this.cam);
				this.snapUri = snapURL.uri;
				if (snapURL.uri.indexOf('http') < 0)
				{
					this.snapUri = null;
				}
			}
			catch (err)
			{
				this.homey.app.updateLog('Failed to fetch Snapshot URL: ' + err.message, 0);
				this.snapUri = null;
			}
		}

		if (!this.snapUri)
		{
			this.homey.app.updateLog('Invalid Snapshot URL, it must be http or https: null', 0);
			return;
		}
		this.homey.app.updateLog('Event snapshot URL (' + this.name + '): ' + this.homey.app.varToString(this.snapUri).replace(this.password, 'YOUR_PASSWORD'));

		let res = await this.doFetch('MOTION EVENT');
		if (!res.ok)
		{
			this.homey.app.updateLog(this.homey.app.varToString(res));
			throw new Error(res.statusText);
		}

		if (!this.eventImageFilename)
		{
			throw new Error('No event image path defined');
		}

		return new Promise((resolve, reject) =>
		{
			const storageStream = fs.createWriteStream(this.homey.app.getUserDataPath(this.eventImageFilename));

			res.body.pipe(storageStream);
			storageStream.on('error', (err) =>
			{
				this.homey.app.updateLog(this.homey.app.varToString(err));
				reject(err);
				return;
			});
			storageStream.on('finish', () =>
			{
				if (this.eventImage)
				{
					this.eventImage.update();
					this.homey.app.updateLog('Event Image Updated (' + this.name + ')', 1);

					let tokens = {
						'eventImage': this.eventImage
					};

					this.driver.eventShotReadyTrigger
						.trigger(this, tokens)
						.catch(err =>
						{
							this.homey.app.updateLog('Snapshot error (' + this.name + '): ' + this.homey.app.varToString(err), 0);
							reject(err);
							return;
						})
						.then(() =>
						{
							resolve(true);
							return;
						});
				}
			});
		});
	}

	async updateMotionImage(delay)
	{
		if (!this.updatingEventImage)
		{
			const settings = this.getSettings();
			this.homey.app.updateLog('Updating Motion Image in ' + settings.delay + 'seconds', 1);

			this.updatingEventImage = true;

			// Safeguard against flag not being reset for some reason
			let timerId = this.homey.setTimeout(() =>
			{
				this.updatingEventImage = false;
			}, delay * 1000 + 20000);

			this.eventTime = new Date(Date.now());
			this.setStoreValue('eventTime', this.eventTime);
			this.setCapabilityValue('event_time', this.convertDate(this.eventTime, settings, false)).catch(this.error);
			if (this.snapshotSupported)
			{
				if (delay > 0)
				{
					await new Promise(resolve => this.homey.setTimeout(resolve, delay * 1000));
				}

				for (let retries = 3; retries > 0; retries--)
				{
					try
					{
						await this.readEventImage();
						break;
					}
					catch (err)
					{
						this.homey.app.updateLog('Event image error (' + this.name + '): ' + err, 0);
						this.homey.clearTimeout(timerId);
						timerId = this.homey.setTimeout(() =>
						{
							this.updatingEventImage = false;
						}, 20000);
					}
				}
			}
			else
			{
				this.homey.app.updateLog('Snapshot not supported (' + this.name + ')', 1);
			}
			this.updatingEventImage = false;
			return true;
		}
		else
		{
			this.homey.app.updateLog('** Event STILL Processing last image (' + this.name + ') **', 0);
			return false;
		}
	}

	async triggerMotionEvent(dataName, dataValue)
	{
		this.setAvailable().catch(this.error);

		if (this.getCapabilityValue('motion_enabled'))
		{
			const settings = this.getSettings();
			this.lastState = dataValue;

			this.homey.app.updateLog('Event Trigger (' + this.name + '):' + dataName + ' = ' + dataValue, 1);
			this.homey.app.triggerMotion({ 'motion_type': dataName, 'device_name': this.name }).catch(this.err);

			if (dataValue)
			{
				// Motion detected so set a timer to clear the motion in case we miss the off event
				if (this.eventTimeoutId)
				{
					this.homey.clearTimeout(this.eventTimeoutId);
				}
				this.eventTimeoutId = this.homey.setTimeout(() =>
				{
					this.eventTimeoutId = null;
					this.setCapabilityValue('alarm_motion', false).catch(this.error);
					console.log('Event off timeout', this.name, this.channel);
				}, 180000);

				if (!settings.single || !this.getCapabilityValue('alarm_motion'))
				{
					// Alarm was off or allowed multiple triggers so check if the minmum on time is up
					if (this.eventMinTimeId == null)
					{
						//start the minimum on time
						this.eventMinTimeId = this.homey.setTimeout(() =>
						{
							console.log('Minimum event time elapsed', this.name, this.channel);
							this.eventMinTimeId = null;
							if (!this.lastState)
							{
								// The event has been turned off already
								this.setCapabilityValue('alarm_motion', false).catch(this.error);
								console.log('Turned off event alarm', this.name, this.channel);
							}
						}, settings.on_time * 1000);

						this.setCapabilityValue('alarm_motion', true).catch(this.error);
						this.updateMotionImage(settings.delay).catch(this.err);
					}
					else
					{
						this.homey.app.updateLog('Ignoring event, too soon (' + this.name + ') ' + dataName, 1);
					}
				}
				else
				{
					this.homey.app.updateLog('Ignoring unchanged Motion event (' + this.name + ') ' + dataName + ' = ' + dataValue, 1);
				}
			}
			else
			{
				if (this.eventMinTimeId == null)
				{
					if (this.getCapabilityValue('alarm_motion'))
					{
						// Minimum time has elapsed so switch the alarm of now
						this.setCapabilityValue('alarm_motion', false).catch(this.error);
						console.log('Turned off event alarm', this.name, this.channel);
					}
				}
				else
				{
					console.log('Event alarm switch off delayed for minimum time', this.name, this.channel);
				}
				this.homey.clearTimeout(this.eventTimeoutId);
				this.eventTimeoutId = null;
			}
		}
		else
		{
			// Unsubscribe from events
			try
			{
				await this.homey.app.unsubscribe(this);
			}
			catch (err)
			{
				this.homey.app.updateLog('unsubscribe error (' + this.name + '): ' + this.homey.app.varToString(err.mesage), 0);
			}
		}
	}

	async triggerTamperEvent(dataName, dataValue)
	{
		this.setAvailable().catch(this.error);

		if (dataValue != this.getCapabilityValue('alarm_tamper'))
		{
			this.homey.app.updateLog('Event Processing (' + this.name + '):' + dataName + ' = ' + dataValue);
			this.setCapabilityValue('alarm_tamper', dataValue).catch(this.error);
			if (dataValue)
			{
				this.alarmTime = new Date(Date.now());
				this.setStoreValue('alarmTime', this.alarmTime).catch(this.err);
				this.setCapabilityValue('tamper_time', this.convertDate(this.alarmTime, this.getSettings(), false)).catch(this.error);
			}
		}
		else
		{
			this.homey.app.updateLog('Ignoring unchanged event (' + this.name + ') ' + dataName + ' = ' + dataValue);
		}
	}

	async triggerLineCrossedEvent(ObjectId)
	{
		this.setAvailable().catch(this.error);

		this.homey.app.updateLog('Event Processing (' + this.name + '):' + ObjectId);
		this.setCapabilityValue('alarm_line_crossed', true).catch(this.error);

		this.triggerMotionEvent('Line Crossed', true).catch(this.err);
		this.driver.eventLineCrossedTrigger
			.trigger(this)
			.catch(this.error)
			.then(this.log('Triggered enable on'));

		// This event doesn't clear so set a timer to clear it
		this.homey.clearTimeout(this.lineCrossedTimeoutId);
		this.lineCrossedTimeoutId = this.homey.setTimeout(() =>
		{
			this.setCapabilityValue('alarm_line_crossed', false).catch(this.error);
			this.triggerMotionEvent('Line Crossed', false).catch(this.err);
			console.log('Line crossed off');
		}, 15000);

	}

	async triggerPersonEvent(dataValue)
	{
		this.setAvailable().catch(this.error);

		this.homey.app.updateLog('Event Processing (' + this.name + '):' + dataValue);
		if (!this.hasCapability('alarm_person'))
		{
			this.addCapability('alarm_person')
				.then(() =>
				{
					this.triggerPersonEvent(dataValue);
				})
				.catch(this.error);

			return;
		}
		else
		{
			this.setCapabilityValue('alarm_person', dataValue).catch(this.error);
		}

		this.triggerMotionEvent('Person Detected', dataValue).catch(this.err);

		this.homey.clearTimeout(this.personTimeoutId);
		if (dataValue)
		{
			this.driver.eventPersonTrigger
				.trigger(this)
				.catch(this.error)
				.then(this.log('Triggered enable on'));

			// If this event doesn't clear, set a timer to clear it
			this.personTimeoutId = this.homey.setTimeout(() =>
			{
				this.setCapabilityValue('alarm_person', false).catch(this.error);
				this.triggerMotionEvent('Person Detected', false).catch(this.err);
				console.log('Person Detected off');
			}, 15000);
		}
	}

	async triggerDogCatEvent(dataValue)
	{
		this.setAvailable().catch(this.error);

		this.homey.app.updateLog('Event Processing (' + this.name + '):' + dataValue);
		if (!this.hasCapability('alarm_dog_cat'))
		{
			this.addCapability('alarm_dog_cat')
				.then(() =>
				{
					this.triggerDogCatEvent(dataValue);
				})
				.catch(this.error);

			return;
		}
		else
		{
			this.setCapabilityValue('alarm_dog_cat', dataValue).catch(this.error);
		}

		this.triggerMotionEvent('Dog / Cat Detected', dataValue).catch(this.err);

		// If this event doesn't clear, set a timer to clear it
		this.homey.clearTimeout(this.dogCatTimeoutId);
		if (dataValue)
		{
			this.driver.eventDogCatTrigger
				.trigger(this)
				.catch(this.error)
				.then(this.log('Triggered enable on'));

			this.dogCatTimeoutId = this.homey.setTimeout(() =>
			{
				this.setCapabilityValue('alarm_dog_cat', false).catch(this.error);
				this.triggerMotionEvent('Dog / Cat Detected', false).catch(this.err);
				console.log('Dog / Cat Detected off');
			}, 15000);
		}
	}

	async triggerVistorEvent(dataValue)
	{
		this.setAvailable().catch(this.error);

		this.homey.app.updateLog('Event Processing (' + this.name + '):' + dataValue);
		if (!this.hasCapability('alarm_visitor'))
		{
			this.addCapability('alarm_visitor')
				.then(() =>
				{
					this.triggerVistorEvent(dataValue);
				})
				.catch(this.error);

			return;
		}
		else
		{
			this.setCapabilityValue('alarm_visitor', dataValue).catch(this.error);
		}

		if (this.hasCapability('alarm_generic'))
		{
			this.setCapabilityValue('alarm_generic', dataValue).catch(this.error);
		}

		this.triggerMotionEvent('Vistor Detected', dataValue).catch(this.err);

		// If this event doesn't clear, set a timer to clear it
		this.homey.clearTimeout(this.vistorTimeoutId);
		if (dataValue)
		{
			this.homey.app.updateLog('Triggering event (' + this.name + ') Vistor Detected  = ' + dataValue, 1);
			this.driver.eventVistorTrigger
				.trigger(this)
				.catch(this.error)
				.then(this.log('Triggered enable on'));

			this.vistorTimeoutId = this.homey.setTimeout(() =>
			{
				if (this.hasCapability('alarm_generic'))
				{
					this.setCapabilityValue('alarm_generic', dataValue).catch(this.error);
				}

				this.setCapabilityValue('alarm_visitor', false).catch(this.error);
				this.triggerMotionEvent('Vistor Detected', false).catch(this.err);
				console.log('Vistor Detected off');
			}, 15000);
		}
	}

	async triggerFaceEvent(dataValue)
	{
		this.setAvailable().catch(this.error);

		this.homey.app.updateLog('Event Processing (' + this.name + '):' + dataValue);
		if (!this.hasCapability('alarm_face'))
		{
			this.addCapability('alarm_face')
				.then(() =>
				{
					this.triggerFaceEvent(dataValue);
				})
				.catch(this.error);

			return;
		}
		else
		{
			this.setCapabilityValue('alarm_face', dataValue).catch(this.error);
		}

		this.triggerMotionEvent('Face Detected', dataValue).catch(this.err);

		// If this event doesn't clear, set a timer to clear it
		this.homey.clearTimeout(this.faceTimeoutId);
		if (dataValue)
		{
			this.driver.eventFaceTrigger
				.trigger(this)
				.catch(this.error)
				.then(this.log('Triggered enable on'));

			this.faceTimeoutId = this.homey.setTimeout(() =>
			{
				this.setCapabilityValue('alarm_face', false).catch(this.error);
				this.triggerMotionEvent('Face Detected', false).catch(this.err);
				console.log('Face Detected off');
			}, 15000);
		}
	}

	async triggerVehicleEvent(dataValue)
	{
		this.setAvailable().catch(this.error);

		this.homey.app.updateLog('Event Processing (' + this.name + '):' + dataValue);
		if (!this.hasCapability('alarm_vehicle'))
		{
			this.addCapability('alarm_vehicle')
				.then(() =>
				{
					this.triggerVehicleEvent(dataValue);
				})
				.catch(this.error);

			return;
		}
		else
		{
			this.setCapabilityValue('alarm_vehicle', dataValue).catch(this.error);
		}

		this.triggerMotionEvent('Vehicle Detected', dataValue).catch(this.err);

		// If this event doesn't clear, set a timer to clear it
		this.homey.clearTimeout(this.vehicleTimeoutId);
		if (dataValue)
		{
			this.driver.eventVehicleTrigger
				.trigger(this)
				.catch(this.error)
				.then(this.log('Triggered enable on'));

			this.vehicleTimeoutId = this.homey.setTimeout(() =>
			{
				this.setCapabilityValue('alarm_vehicle', false).catch(this.error);
				this.triggerMotionEvent('Vehicle Detected', false).catch(this.err);
				console.log('Vehicle Detected off');
			}, 5000);
		}
	}

	async triggerDarkImageEvent(value)
	{
		this.setAvailable().catch(this.error);

		this.homey.app.updateLog('Event Processing (' + this.name + '):' + value);
		this.setCapabilityValue('alarm_dark_image', value).catch(this.error);
	}

	async listenForEvents(cam_obj)
	{
		if (cam_obj)
		{ //Stop listening for motion events before we add a new listener
			cam_obj.removeAllListeners('event');

			this.log('listenForEvents');

			if (this.updatingEventImage)
			{

				this.log('listenForEvents blocked bu updating image');

				// Wait while repairing and try again later
				this.eventTimerId = this.homey.setTimeout(this.listenForEvents.bind(this, cam_obj), 2000);
			}
			else
			{
				if (this.supportPushEvent && !this.preferPullEvents)
				{
					this.homey.app.updateLog('\r\n## registering Push events (' + this.name + ') ##');

					try
					{
						await this.homey.app.subscribeToCamPushEvents(this);
						this.homey.app.updateLog('\r\n## Waiting for Push events (' + this.name + ') ##');
						return;
					}
					catch (error)
					{
						this.homey.app.updateLog(`\r\n## FAILED to register Push events (${this.name}) ${error.message} ##`, 0);
					}

					// this.checkCamera();
					return;
				}

				this.homey.app.updateLog('## Waiting for Pull events (' + this.name + ') ##');
				cam_obj.on('event', (camMessage, xml) =>
				{
					this.processCamEventMessage(camMessage).catch(this.err);
				});
			}
		}
	}

	async processCamEventMessage(camMessage)
	{
		if (this.getCapabilityValue('motion_enabled'))
		{
			try
			{
				this.homey.app.updateLog('\r\n--  Event detected (' + this.name + ')  --', 1);
				this.homey.app.updateLog(this.homey.app.varToString(camMessage));

				let dataSource = camMessage?.message.message.data.simpleItem;
				if (this.token)
				{
					let eventSource = camMessage.message?.message.source.simpleItem;
					if (Array.isArray(eventSource))
					{
						eventSource = eventSource[0];
					}

					if (eventSource.$)
					{
						this.homey.app.updateLog(`*** Event token ${eventSource.$.Value}, channel token ${this.token} `, 1);

						if ((eventSource.$.Name == 'VideoSourceConfigurationToken') ||
							(eventSource.$.Name == 'Source'))
						{
							if (eventSource.$.Value !== this.token)
							{
								// Different channel so ignore this event
								this.homey.app.updateLog(`Event Ignored on this channel:\r\n${this.homey.app.varToString(dataSource)}\r\n`, 1);
								return;
							}
						}
					}
					else
					{
						this.homey.app.updateLog(`*** Event source invalid: ${this.homey.app.varToString(camMessage)}`, 1);
					}
				}

				this.setAvailable().catch(this.error);

				let eventTopic = camMessage.topic._;
				eventTopic = this.homey.app.stripNamespaces(eventTopic);

				let dataName = '';
				let dataValue = '';
				let objectId = '';

				// DATA (Name:Value)
				if (dataSource)
				{
					if (Array.isArray(dataSource))
					{
						dataName = camMessage.message.message.data.simpleItem[0].$.Name;
						dataValue = camMessage.message.message.data.simpleItem[0].$.Value;
					}
					else
					{
						dataName = camMessage.message.message.data.simpleItem.$.Name;
						dataValue = camMessage.message.message.data.simpleItem.$.Value;
					}
				}
				else if (camMessage.message.message.data && camMessage.message.message.data.elementItem)
				{
					this.homey.app.updateLog('WARNING: Data contains an elementItem', 0);
					dataName = 'elementItem';
					dataValue = this.homey.app.varToString(camMessage.message.message.data.elementItem);
				}
				else
				{
					this.homey.app.updateLog('WARNING: Data does not contain a simpleItem or elementItem', 0);
					dataName = null;
					dataValue = null;
				}

				if (dataName)
				{
					if (camMessage.message.message.key && camMessage.message.message.key.simpleItem)
					{
						objectId = camMessage.message.message.key.simpleItem.$.Value;
					}

					this.homey.app.updateLog('Event data: (' + this.name + ') ' + eventTopic + ': ' + dataName + ' = ' + dataValue + (objectId === '' ? '' : (' (' + objectId + ')')), 1, true);
					const compareSetting = eventTopic + ':' + dataName;
					if ((compareSetting === this.eventTN) && ((this.eventObjectID === '') || (this.eventObjectID.indexOf(objectId) >= 0)))
					{
						this.triggerMotionEvent(dataName, dataValue).catch(this.err);
					}
					else if ((compareSetting === 'RuleEngine/LineDetector/Crossed:ObjectId') && ((this.eventObjectID === '') || (this.eventObjectID.indexOf(dataValue) >= 0)))
					{
						// Line crossed
						this.triggerLineCrossedEvent(dataValue).catch(this.err);
					}
					else if (compareSetting === 'VideoSource/ImageTooDark/ImagingService:State')
					{
						// Image too dark dataName = 'State', 'dataValue = true / false
						this.triggerDarkImageEvent(dataValue).catch(this.err);
					}
					else if (compareSetting === 'Monitoring/ProcessorUsage:Value')
					{
						// Processor usage = 'Value', 'dataValue = %usage
						if (!this.hasCapability('measure_cpu'))
						{
							await this.addCapability('measure_cpu');
						}
						if (dataValue <= 1)
						{
							dataValue *= 100;
						}
						this.setCapabilityValue('measure_cpu', dataValue).catch(this.error);
					}
					else if (compareSetting === 'Device/HardwareFailure/StorageFailure:Failed')
					{
						// Processor usage = 'Value', 'dataValue = %usage
						if (!this.hasCapability('alarm_storage'))
						{
							await this.addCapability('alarm_storage');
						}
						this.setCapabilityValue('alarm_storage', dataValue).catch(this.error);
					}
					else if (compareSetting === 'AudioAnalytics/Audio/DetectedSound:IsSoundDetected')
					{
						// Processor usage = 'Value', 'dataValue = %usage
						this.setCapabilityValue('alarm_sound', dataValue).catch(this.error);
					}
					else if (compareSetting === 'RuleEngine/MyRuleDetector/Visitor:State')
					{
						// Vistor
						this.triggerVistorEvent(dataValue).catch(this.err);
					}
					else if ((compareSetting === 'RuleEngine/MyRuleDetector/PeopleDetect:State') || (compareSetting === 'RuleEngine/PeopleDetector/People:IsPeople'))
					{
						// Person
						this.triggerPersonEvent(dataValue).catch(this.err);
					}
					else if (compareSetting === 'RuleEngine/MyRuleDetector/FaceDetect:State')
					{
						// Face
						this.triggerFaceEvent(dataValue).catch(this.err);
					}
					else if (compareSetting === 'RuleEngine/MyRuleDetector/VehicleDetect:State')
					{
						// Vehicle
						this.triggerVehicleEvent(dataValue).catch(this.err);
					}
					else if (compareSetting === 'RuleEngine/MyRuleDetector/DogCatDetect:State')
					{
						// Dog or Cat
						this.triggerDogCatEvent(dataValue).catch(this.err);
					}
					else if (dataName === 'IsTamper')
					{
						this.triggerTamperEvent(dataName, dataValue).catch(this.err);
					}
					else
					{
						this.homey.app.updateLog('Ignoring event type (' + this.name + ') ' + eventTopic + ': ' + dataName + ' = ' + dataValue);
					}
				}
			}
			catch (err)
			{
				this.homey.app.updateLog('Camera Event Error (' + this.name + '): ' + err.message, 0);
			}
		}
	}

	async onCapabilityMotionEnable(value, opts)
	{
		if (this.cameraEnabled)
		{
			try
			{
				this.homey.clearTimeout(this.eventTimerId);

				console.log('onCapabilityMotionEnable: ', value);
				this.setCapabilityValue('alarm_motion', false).catch(this.error);

				if (value && this.hasMotion)
				{
					this.homey.app.updateLog('Switch motion detection On (' + this.name + ')');

					// Start listening for motion events
					setImmediate(() =>
					{
						this.listenForEvents(this.cam).catch(this.error);
						return;
					});

					this.driver.motionEnabledTrigger
						.trigger(this)
						.catch(this.error)
						.then(this.log('Triggered enable on'));
				}
				else
				{
					try
					{
						this.homey.app.updateLog('Switch motion detection Off (' + this.name + ')');

						// Switch off the current event mode
						await this.homey.app.unsubscribe(this);

					}
					catch (err)
					{
						this.homey.app.updateLog(this.getName() + ' onCapabilityOff Error (' + this.name + ') ' + err.mesage, 0);
						throw (err);
					}

					this.driver.motionDisabledTrigger
						.trigger(this)
						.catch(this.error)
						.then(this.log('Triggered enable off'));
				}

			}
			catch (err)
			{
				//this.setUnavailable();
				this.homey.app.updateLog(this.getName() + ' onCapabilityOnoff Error (' + this.name + ') ' + err.message, 0);
				throw (err);
			}
		}
	}

	async setupImages()
	{

		if (this.homey.app.checkSymVersionGreaterEqual(this.homey.version, 12, 7, 0) && !this.video)
		{
			this.homey.app.updateLog('Registering Now video stream (' + this.name + ')');
			this.video = await this.homey.videos.createVideoRTSP();
			this.video.registerVideoUrlListener(async () =>
			{
				const reply = await this.homey.app.getStreamURL(this.cam);
				this.homey.app.updateLog(`Setting Live video stream to ${reply.uri}`);
				const url = `${reply.uri}`;
				let newUrl = url;
				// If the url doesn't contain user=<username> then add it
				if (!url.includes(`user=${this.username}`))
				{
					// insert the username and password just after the protocol in the format [username:password@<host>]
					const auth = `${this.username}:${this.password}@`;
					const host = reply.uri.split('/')[2];
					newUrl = url.replace(host, auth + host);
				}
				this.homey.app.updateLog(`Setting Live video stream to ${newUrl}`);
				return { url: newUrl };
			});
			this.setCameraVideo('NowVideo', 'Live Video', this.video).catch(this.err);
			this.homey.app.updateLog('registered Now video stream (' + this.name + ')');
		}

		if (!this.snapshotSupported && !this.userSnapUri)
		{
			return;
		}

		try
		{
			this.setWarning(null);

			const devData = this.getData();

			this.invalidAfterConnect = false;
			if (this.channel > 0)
			{
				this.cam.setActiveSource(this.channel - 1);
			}

			if (!this.userSnapUri)
			{
				// Use ONVIF snapshot URL
				const snapURL = await this.homey.app.getSnapshotURL(this.cam);
				if (snapURL.uri.indexOf('http') < 0)
				{
					this.snapUri = null;
					this.homey.app.updateLog('Invalid Snapshot URL, it must be http or https: ' + this.homey.app.varToString(snapURL.uri).replace(this.password, 'YOUR_PASSWORD'), 0);
					return;
				}

				this.snapUri = snapURL.uri;
				this.invalidAfterConnect = snapURL.invalidAfterConnect;

			}
			else
			{
				this.snapUri = this.userSnapUri;
			}

			// if (this.channel >= 0)
			// {
			//     // Check if the uri has a channel number and replace it with the settings
			//     let chanelPos = this.snapUri.indexOf("channel=");
			//     if (chanelPos > 0)
			//     {
			//         let tempStr = this.snapUri.substr(0, chanelPos + 8) + this.channel + this.snapUri.substr(chanelPos + 9);
			//         this.snapUri = tempStr;
			//     }
			// }

			const publicSnapURL = this.snapUri.replace(this.password, 'YOUR_PASSWORD');
			await this.setSettings(
				{
					'url': publicSnapURL
				});

			this.homey.app.updateLog('Snapshot URL: ' + publicSnapURL);

			try
			{
				if (!this.nowImage)
				{
					this.nowImage = await this.homey.images.createImage();
					this.nowImage.setStream(async (stream) =>
					{
						if (this.invalidAfterConnect)
						{
							await this.homey.app.getSnapshotURL(this.cam);
						}

						let res = await this.doFetch('NOW');
						if (!res.ok)
						{
							this.homey.app.updateLog('Fetch NOW error (' + this.name + '): ' + res.statusText, 0);
							this.setWarning(res.statusText);
							throw new Error(res.statusText);
						}

						res.body.pipe(stream);

						stream.on('error', (err) =>
						{
							this.homey.app.updateLog('Fetch Now image error (' + this.name + '): ' + err.message, 0);
						});
						stream.on('finish', () =>
						{
							this.homey.app.updateLog('Now Image Updated (' + this.name + ')');
						});
					});

					this.homey.app.updateLog('Registering Now image (' + this.name + ')');
					this.setCameraImage('Now', this.homey.__('Now'), this.nowImage).catch(this.err);
					this.homey.app.updateLog('registered Now image (' + this.name + ')');
				}
			}
			catch (err)
			{
				this.homey.app.updateLog('SnapShot nowImage error (' + this.name + ') = ' + err.message, 0);
			}

			try
			{
				const imageFilename = 'eventImage' + devData.id;
				this.eventImageFilename = imageFilename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
				this.eventImageFilename += '.jpg';
				this.homey.app.updateLog('SnapShot save file (' + this.name + ') = ' + this.eventImageFilename);

				const eventImagePath = this.homey.app.getUserDataPath(this.eventImageFilename);
				if (!fs.existsSync(eventImagePath))
				{
					this.updatingEventImage = true;

					this.homey.app.updateLog('Initialising event image (' + this.name + ')');
					// Initialise the event image with the current snapshot
					const storageStream = fs.createWriteStream(eventImagePath);
					this.homey.app.updateLog('Fetching event image (' + this.name + ')');

					if (this.invalidAfterConnect)
					{
						// Suggestions on the internet say this has to be called before getting the snapshot if invalidAfterConnect = true
						await this.homey.app.getSnapshotURL(this.cam);
					}

					let res = await this.doFetch('Motion Event');
					if (!res.ok)
					{
						this.homey.app.updateLog('Fetch MOTION error (' + this.name + '): ' + this.homey.app.varToString(res), 0);
						this.updatingEventImage = false;
						throw new Error(res.statusText);
					}

					res.body.pipe(storageStream);

					storageStream.on('error', (err) =>
					{
						this.homey.app.updateLog('Fetch event image error (' + this.name + '): ' + err.message, true);
						this.updatingEventImage = false;
					});
					storageStream.on('finish', () =>
					{
						this.homey.app.updateLog('Event Image Updated (' + this.name + ')');
						this.updatingEventImage = false;
					});

					// Allow time for the image to download before setting up the view image
					await new Promise(resolve => this.homey.setTimeout(resolve, 2000));
				}

				// Register the event image, even if motion is not supported, so it can be initiated by the flow action
				if (!this.eventImage)
				{
					this.homey.app.updateLog('Registering event image (' + this.name + ')');
					this.eventImage = await this.homey.images.createImage();
					this.eventImage.setPath(eventImagePath);
					this.homey.app.updateLog('registered event image (' + this.name + ')');
					this.setCameraImage('Event', this.homey.__('Motion_Event'), this.eventImage).catch(this.err);
				}
			}
			catch (err)
			{
				this.homey.app.updateLog('Event SnapShot error (' + this.name + '): ' + err.message, 0);
				this.updatingEventImage = false;
			}
		}
		catch (err)
		{
			//this.homey.app.updateLog("SnapShot error: " + this.homey.app.varToString(err), true);
			this.homey.app.updateLog('SnapShot error (' + this.name + '): ' + err.message, 0);
		}
	}

	async doFetch(name)
	{
		let res = {};
		var agent = null;

		if (this.snapUri.indexOf('https:') == 0)
		{
			agent = new https.Agent({ rejectUnauthorized: false });
		}
		else
		{
			agent = new http.Agent({ rejectUnauthorized: false });
		}

		const startAuthType = this.authType;
		do
		{
			try
			{
				if (this.authType == 0)
				{
					this.homey.app.updateLog('Fetching (' + this.name + ') ' + name + ' image with no Auth from: ' + this.homey.app.varToString(this.snapUri).replace(this.password, 'YOUR_PASSWORD'), 1);
					res = await fetch(this.snapUri, { agent: agent });
					this.homey.app.updateLog(`SnapShot fetch result (${this.name}): Status: ${res.ok}, Message: ${res.statusText}, Code: ${res.status}\r\n`, 1);
					if (!res.ok)
					{
						// Try Basic Authentication
						this.authType = 1;
					}
					else
					{
						break;
					}
				}
			}
			catch (err)
			{
				this.homey.app.updateLog('SnapShot error (' + this.name + '): ' + err.message, 0);
				// Try Basic Authentication
				this.authType = 1;

				res = {
					'ok': false,
					'statusText': err.code
				};

				if (startAuthType === this.authType)
				{
					// Tried all the methods now
					break;
				}
			}

			try
			{
				if (this.authType == 1)
				{
					this.homey.app.updateLog('Fetching (' + this.name + ') ' + name + ' image with Basic Auth. From: ' + this.homey.app.varToString(this.snapUri).replace(this.password, 'YOUR_PASSWORD'), 1);

					const client = new DigestFetch(this.username, this.password, { basic: true, });
					res = await client.fetch(this.snapUri, { agent: agent });
					this.homey.app.updateLog(`SnapShot fetch result (${this.name}): Status: ${res.ok}, Message: ${res.statusText}, Code: ${res.status}\r\n`, 1);
					if (!res.ok)
					{
						// Try Digest Authentication
						this.authType = 2;
					}
					else
					{
						break;
					}
				}
			}
			catch (err)
			{
				this.homey.app.updateLog('SnapShot error (' + this.name + '): ' + err.message, 0);
				// Try Digest Authentication
				this.authType = 2;

				res = {
					'ok': false,
					'statusText': err.code
				};

				if (startAuthType === this.authType)
				{
					// Tried all the methods now
					break;
				}
			}

			try
			{
				if (this.authType >= 2)
				{
					this.homey.app.updateLog('Fetching (' + this.name + ') ' + name + ' image with Digest Auth. From: ' + this.homey.app.varToString(this.snapUri).replace(this.password, 'YOUR_PASSWORD'), 1);

					const client = new DigestFetch(this.username, this.password, { algorithm: 'MD5' });
					res = await client.fetch(this.snapUri, { agent: agent });
					this.homey.app.updateLog(`SnapShot fetch result (${this.name}): Status: ${res.ok}, Message: ${res.statusText}, Code: ${res.status}\r\n`, 1);
					if (!res.ok)
					{
						// Go back to no Authentication
						this.authType = 0;
					}
					else
					{
						break;
					}
				}
			}
			catch (err)
			{
				this.homey.app.updateLog('SnapShot error (' + this.name + '): ' + err.message, 0);

				// Go back to no Authentication
				this.authType = 0;

				res = {
					'ok': false,
					'statusText': err.code
				};

				if (startAuthType === this.authType)
				{
					// Tried all the methods now
					break;
				}
			}
		}
		while (this.authType !== startAuthType);

		if (!res.ok)
		{
			this.setWarning(res.statusText).catch(this.error);
		}
		else
		{
			this.setWarning(null).catch(this.error);
		}

		return res;
	}

	async logout()
	{
		if (this.cam)
		{
			this.clearTimers();
			if (this.cam)
			{
				//Stop listening for motion events
				this.cam.removeAllListeners('event');
				this.homey.app.unsubscribe(this).catch(this.err);
			}
			this.cam = null;
		}
	}

	async onDeleted()
	{
		try
		{
			this.clearTimers();
			if (this.cam)
			{
				//Stop listening for motion events
				this.cam.removeAllListeners('event');
				this.homey.app.unsubscribe(this).catch(this.err);
			}

			if (this.eventImageFilename)
			{
				const eventImagePath = this.homey.app.getUserDataPath(this.eventImageFilename);
				if (!fs.existsSync(eventImagePath))
				{
					fs.unlink(eventImagePath, (err) =>
					{
						if (!err)
						{
							//console.log('successfully deleted: ', this.eventImageFilename);
						}
					});
				}
			}
			console.log('Delete device');
		}
		catch (err)
		{
			console.log('Delete device error', err);
		}
	}

	clearTimers()
	{
		this.homey.clearTimeout(this.checkTimerId);
		this.checkTimerId = null;
		this.homey.clearTimeout(this.eventTimerId);
		this.eventTimerId = null;
	}

	async onCapabilityPTZPreset(value)
	{
		return this.gotoPreset(value);
	}

	async gotoPresetNumber(presetNumber)
	{
		if (!this.cam) return;

		// Get the capability options for PTZ presets
		const options = this.getCapabilityOptions('ptz_preset');
		if (!options || !options.values || options.values.length === 0)
		{
			this.homey.app.updateLog(`No PTZ presets available for ${this.name}`, 0);
			throw new Error('No PTZ presets available');
		}
		if (presetNumber < 1 || presetNumber > options.values.length)
		{
			this.homey.app.updateLog(`Preset number ${presetNumber} is out of range for ${this.name}`, 0);
			throw new Error(`Preset number ${presetNumber} is out of range`);
		}
		const presetToken = options.values[presetNumber - 1].id; // Get the token for the preset
		this.homey.app.updateLog(`Moving to preset number ${presetNumber} (${presetToken}) for ${this.name}`, 1);
		return this.gotoPreset(presetToken);
	}

	async gotoPreset(presetToken)
	{
		if (!this.cam)
		{
			throw new Error('Camera not connected');
		}

		try
		{
			// Check if the camera has PTZ capabilities
			const ptzStatus = await this.homey.app.getPTZStatus(this.cam);
			if (!ptzStatus)
			{
				throw new Error('This camera does not support PTZ');
			}

			// Use the preset token to move the camera
			await new Promise((resolve, reject) =>
			{
				this.cam.gotoPreset({
					preset: String(presetToken)  // Convert presets to appropriate format for capability options
				}, (err) =>
				{
					if (err)
					{
						this.homey.app.updateLog(`Error when moving to preset ${presetToken}: ${err.message}`, 0);
						reject(err);
						return;
					}
					this.homey.app.updateLog(`Successfully moved to preset ${presetToken}`, 1);
					resolve();
				});
			});

			return true;

		}
		catch (err)
		{
			this.homey.app.updateLog(`PTZ error (${this.name}): ${err.message}`, 0);
			throw err;
		}
	}

	async updatePresets()
	{
		if (!this.cam) return;

		try
		{
			await new Promise((resolve, reject) =>
			{
				this.cam.getPresets({}, (err, presets) =>
				{
					if (err)
					{
						reject(err);
						return;
					}

					// Convert presets to appropriate format for capability options
					const presetValues = Object.entries(presets).map(([name, token], index) => ({
						id: String(token), // Convert token to chain
						title: {
							en: `Preset ${index + 1}: ${name}`,
							fr: `Position ${index + 1}: ${name}`
						}
					}));

					this.homey.app.updateLog(`Presets found (${this.name}): ${presetValues.length}`, 1);

					// Update capability options with the correct number of presets
					this.setCapabilityOptions('ptz_preset', {
						values: presetValues,
						title: {
							en: `PTZ Preset (${presetValues.length} positions)`,
							fr: `Positions PTZ (${presetValues.length} positions)`
						},
						subtitle: {
							en: "Select a preset position",
							fr: "Sélectionner une position préréglée"
						}
					}).catch(err =>
					{
						this.homey.app.updateLog(`Error updating preset options: ${err.message}`, 0);
					});

					resolve();
				});
			});
		}
		catch (err)
		{
			this.homey.app.updateLog(`Error updating presets: ${err.message}`, 0);
		}
	}
}

module.exports = CameraDevice;