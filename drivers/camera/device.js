/* eslint-disable no-unused-vars */
/*jslint node: true */
'use strict';

const Homey = require('homey');
const DigestFetch = require('digest-fetch');
const fetch = require('node-fetch');
const https = require('https');
const http = require('http');
const fs = require('fs');
const {
	EVENT_METRIC_HANDLERS,
	createEventCompareHandlers,
	createEventSpecialHandlers
} = require('./event-routing');

const notificationMap = {
	'RuleEngine/CellMotionDetector/Motion:IsMotion': ['MOTION'],
	'RuleEngine/FieldDetector/ObjectsInside:IsInside': ['ANALYTICSSERVICE', 'OBJECTSINSIDE'],
	'VideoSource/MotionAlarm:State': ['MOTIONALARM'],
	'Device/Trigger/DigitalInput:LogicalState': ['DIGITALINPUT']
};

const OPTIONAL_EVENT_CAPABILITIES = {
	line_crossed: { capability: 'alarm_line_crossed', defaultValue: false },
	person: { capability: 'alarm_person', defaultValue: false },
	visitor: { capability: 'alarm_visitor', defaultValue: false },
	face: { capability: 'alarm_face', defaultValue: false },
	dog_cat: { capability: 'alarm_dog_cat', defaultValue: false },
	vehicle: { capability: 'alarm_vehicle', defaultValue: false },
	dark_image: { capability: 'alarm_dark_image', defaultValue: false },
	storage: { capability: 'alarm_storage', defaultValue: false },
	cpu: { capability: 'measure_cpu', defaultValue: 0 },
	sound: { capability: 'alarm_sound', defaultValue: false }
};

const OPTIONAL_EVENT_SUPPORT_HINTS = {
	line_crossed: ['RULEENGINE/LINEDETECTOR/CROSSED', 'LINEDETECTOR/CROSSED', 'CROSSED'],
	person: ['RULEENGINE/MYRULEDETECTOR/PEOPLEDETECT', 'RULEENGINE/PEOPLEDETECTOR/PEOPLE', 'PEOPLEDETECT'],
	visitor: ['RULEENGINE/MYRULEDETECTOR/VISITOR', 'MYRULEDETECTOR/VISITOR', 'VISITOR'],
	face: ['RULEENGINE/MYRULEDETECTOR/FACEDETECT', 'MYRULEDETECTOR/FACEDETECT', 'FACEDETECT'],
	dog_cat: ['RULEENGINE/MYRULEDETECTOR/DOGCATDETECT', 'MYRULEDETECTOR/DOGCATDETECT', 'DOGCATDETECT'],
	vehicle: ['RULEENGINE/MYRULEDETECTOR/VEHICLEDETECT', 'MYRULEDETECTOR/VEHICLEDETECT', 'VEHICLEDETECT'],
	dark_image: ['VIDEOSOURCE/IMAGETOODARK/IMAGINGSERVICE', 'IMAGETOODARK/IMAGINGSERVICE', 'IMAGETOODARK'],
	storage: ['DEVICE/HARDWAREFAILURE/STORAGEFAILURE', 'HARDWAREFAILURE/STORAGEFAILURE', 'STORAGEFAILURE'],
	cpu: ['MONITORING/PROCESSORUSAGE', 'PROCESSORUSAGE'],
	sound: ['AUDIOANALYTICS/AUDIO/DETECTEDSOUND', 'DETECTEDSOUND']
};

const EVENT_RATE_LIMIT_WINDOW_MS = 5000;
const MAX_EVENTS_PER_WINDOW = 100;
const MAX_CONCURRENT_EVENT_HANDLERS = 8;
const EVENT_FLOOD_WARNING_INTERVAL_MS = 15000;

class CameraDevice extends Homey.Device
{
	async onInit()
	{
		this.err = (err) => this.error(err);
		this.eventCompareHandlers = createEventCompareHandlers(this);
		this.eventSpecialHandlers = createEventSpecialHandlers(this);
		this.lastSnapshotIssueLogAt = {};

		this.repairing = false;
		this.connecting = false;
		this.isReady = false;
		this.isDeleting = false;
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
		this.connectCooldownUntil = 0;
		this.eventTimerId = null;
		this.video = null;
		this.activeEventHandlers = 0;
		this.eventWindowStartedAt = 0;
		this.eventCountInWindow = 0;
		this.droppedEventCount = 0;
		this.lastEventFloodWarningAt = 0;

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

		if (typeof settings.token !== 'string')
		{
			await this.setSettings(
				{
					'token': settings.token !== undefined && settings.token !== null ? String(settings.token) : ''
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
		this.userliveUri = settings.userLiveUri;
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
		try
		{
			await this.setStoreValue('optionalSettingsInitialized', false);
		}
		catch (err)
		{
			this.homey.app.updateLog('setStoreValue optionalSettingsInitialized error (' + this.name + '): ' + (err?.message || err), 0);
		}
	}

	async notificationTypesUpdated(settings)
	{
		// make sure to process synchronously else the system gets confused and doesn't add / remove capabilities correctly.
		for (const settingName of Object.keys(OPTIONAL_EVENT_CAPABILITIES))
		{
			await this.syncOptionalCapability(settingName, settings);
		}
	}

	getOptionalEventCapability(settingName)
	{
		const capabilityConfig = OPTIONAL_EVENT_CAPABILITIES[settingName];
		if (capabilityConfig)
		{
			return capabilityConfig;
		}

		return null;
	}

	getSupportedOptionalEventSettings(supportedEvents)
	{
		const reportedTypes = Array.isArray(supportedEvents)
			? supportedEvents.map((eventType) => String(eventType || '').toUpperCase())
			: [];

		return Object.keys(OPTIONAL_EVENT_CAPABILITIES).filter((settingName) =>
		{
			const hints = OPTIONAL_EVENT_SUPPORT_HINTS[settingName] || [];
			return hints.some((hint) => reportedTypes.some((eventType) => eventType.indexOf(hint) >= 0));
		});
	}

	buildUnsupportedOptionalSettingsUpdate(currentSettings, supportedOptionalSettings)
	{
		const update = {};
		for (const settingName of Object.keys(OPTIONAL_EVENT_CAPABILITIES))
		{
			if (supportedOptionalSettings.indexOf(settingName) < 0)
			{
				update[settingName] = false;
			}
			else if (typeof currentSettings[settingName] !== 'boolean')
			{
				update[settingName] = true;
			}
		}

		return update;
	}

	async syncOptionalCapability(settingName, settings = this.getSettings())
	{
		const capabilityConfig = this.getOptionalEventCapability(settingName);
		if (!capabilityConfig)
		{
			return false;
		}

		if (settings[settingName] === true)
		{
			if (!this.hasCapability(capabilityConfig.capability))
			{
				try
				{
					this.homey.app.updateLog('Adding optional capability (' + this.name + '): ' + capabilityConfig.capability, 0);
					await this.addCapability(capabilityConfig.capability);
					await this.setCapabilityValue(capabilityConfig.capability, capabilityConfig.defaultValue);
				}
				catch (err)
				{
					this.homey.app.updateLog('Error adding optional capability (' + this.name + '): ' + capabilityConfig.capability + ': ' + this.homey.app.varToString(err), 0);
				}
			}

			return true;
		}

		if (this.hasCapability(capabilityConfig.capability))
		{
			try
			{
				this.homey.app.updateLog('Removing optional capability (' + this.name + '): ' + capabilityConfig.capability, 0);
				await this.removeCapability(capabilityConfig.capability);
			}
			catch (err)
			{
				this.homey.app.updateLog('Error removing optional capability (' + this.name + '): ' + capabilityConfig.capability + ': ' + this.homey.app.varToString(err), 0);
			}
		}

		return false;
	}

	async ensureOptionalCapability(settingName, settings = this.getSettings())
	{
		const capabilityConfig = this.getOptionalEventCapability(settingName);
		if (!capabilityConfig)
		{
			return false;
		}

		if (settings[settingName] !== true)
		{
			if (this.hasCapability(capabilityConfig.capability))
			{
				try
				{
					this.homey.app.updateLog('Removing optional capability (' + this.name + '): ' + capabilityConfig.capability, 0);
					await this.removeCapability(capabilityConfig.capability);
				}
				catch (err)
				{
					this.homey.app.updateLog('Error removing optional capability (' + this.name + '): ' + capabilityConfig.capability + ': ' + this.homey.app.varToString(err), 0);
				}
			}

			return false;
		}

		if (!this.hasCapability(capabilityConfig.capability))
		{
			try
			{
				this.homey.app.updateLog('Adding optional capability (' + this.name + '): ' + capabilityConfig.capability, 0);
				await this.addCapability(capabilityConfig.capability);
				await this.setCapabilityValue(capabilityConfig.capability, capabilityConfig.defaultValue).catch(this.error);
			}
			catch (err)
			{
				this.homey.app.updateLog('Error adding optional capability (' + this.name + '): ' + capabilityConfig.capability + ': ' + this.homey.app.varToString(err), 0);
			}
		}

		return this.hasCapability(capabilityConfig.capability);
	}

	normalizeEventValue(value)
	{
		if (value === 'true')
		{
			return true;
		}

		if (value === 'false')
		{
			return false;
		}

		return value;
	}

	logSnapshotIssue(key, message, level = 0, throttleMs = 60000)
	{
		const now = Date.now();
		const lastLoggedAt = this.lastSnapshotIssueLogAt[key] || 0;
		if ((now - lastLoggedAt) >= throttleMs)
		{
			this.lastSnapshotIssueLogAt[key] = now;
			this.homey.app.updateLog(message, level);
		}
	}

	getLogDeviceLabel()
	{
		return this.name + (this.ip ? ' [' + this.ip + ']' : '');
	}

	resetEventFloodWindow(now)
	{
		if (!this.eventWindowStartedAt || ((now - this.eventWindowStartedAt) >= EVENT_RATE_LIMIT_WINDOW_MS))
		{
			if (this.eventWindowStartedAt && (this.droppedEventCount > 0))
			{
				this.homey.app.updateLog(
					'Event flood protection recovered (' + this.getLogDeviceLabel() + '): dropped ' + this.droppedEventCount + ' events in the previous window',
					0
				);
			}

			this.eventWindowStartedAt = now;
			this.eventCountInWindow = 0;
			this.droppedEventCount = 0;
		}
	}

	noteDroppedCameraEvent(now, reason)
	{
		this.droppedEventCount += 1;
		const windowElapsedMs = Math.max(1, now - this.eventWindowStartedAt);
		const eventsPerSecond = (this.eventCountInWindow * 1000) / windowElapsedMs;

		if (!this.lastEventFloodWarningAt || ((now - this.lastEventFloodWarningAt) >= EVENT_FLOOD_WARNING_INTERVAL_MS))
		{
			this.lastEventFloodWarningAt = now;
			this.homey.app.updateLog(
				'Event flood protection active (' + this.getLogDeviceLabel() + '): dropping excess camera events (' + reason + ', ' + this.eventCountInWindow + ' events in ' + windowElapsedMs + ' ms, burst rate ' + eventsPerSecond.toFixed(1) + ' events/s)',
				0
			);
		}

		return true;
	}

	shouldDropCameraEvent()
	{
		const now = Date.now();
		this.resetEventFloodWindow(now);

		if (this.activeEventHandlers >= MAX_CONCURRENT_EVENT_HANDLERS)
		{
			return this.noteDroppedCameraEvent(now, 'busy');
		}

		this.eventCountInWindow += 1;
		if (this.eventCountInWindow > MAX_EVENTS_PER_WINDOW)
		{
			return this.noteDroppedCameraEvent(now, 'rate-limit');
		}

		return false;
	}

	isTransientSnapshotError(err)
	{
		const details = `${err?.code || ''} ${err?.message || ''}`.toLowerCase();
		return details.includes('socket hang up') ||
			details.includes('econnreset') ||
			details.includes('etimedout') ||
			details.includes('ehostunreach') ||
			details.includes('econnrefused');
	}

	logSnapshotFetchError(err, name)
	{
		const message = err?.message || this.homey.app.varToString(err);
		if (this.isTransientSnapshotError(err))
		{
			this.logSnapshotIssue(
				'snapshot_transient_error',
				'Snapshot transient error (' + this.getLogDeviceLabel() + ') [' + name + ']: ' + message,
				1,
				60000
			);
			return;
		}

		this.homey.app.updateLog('SnapShot error (' + this.getLogDeviceLabel() + '): ' + message, 0);
	}

	isEventObjectIdEnabled(objectId)
	{
		return (this.eventObjectID === '') || (this.eventObjectID.indexOf(objectId) >= 0);
	}

	isEventForActiveToken(camMessage, dataSource)
	{
		if (!this.token)
		{
			return true;
		}

		let eventSource = camMessage.message?.message.source.simpleItem;
		if (Array.isArray(eventSource))
		{
			eventSource = eventSource[0];
		}

		if (eventSource?.$)
		{
			this.homey.app.updateLog(`*** Event token ${eventSource.$.Value}, channel token ${this.token} `, 1);

			if ((eventSource.$.Name == 'VideoSourceConfigurationToken') ||
				(eventSource.$.Name == 'Source'))
			{
				if (eventSource.$.Value !== this.token)
				{
					// Different channel so ignore this event
					this.homey.app.updateLog(`Event Ignored on this channel:\r\n${this.homey.app.varToString(dataSource)}\r\n`, 1);
					return false;
				}
			}

			return true;
		}

		this.homey.app.updateLog(`*** Event source invalid: ${this.homey.app.varToString(camMessage)}`, 1);
		return true;
	}

	parseCamEvent(camMessage)
	{
		let dataName = '';
		let dataValue = '';
		let objectId = '';
		const dataSource = camMessage?.message.message.data.simpleItem;

		if (!this.isEventForActiveToken(camMessage, dataSource))
		{
			return null;
		}

		let eventTopic = camMessage.topic._;
		eventTopic = this.homey.app.stripNamespaces(eventTopic);

		// DATA (Name:Value)
		if (dataSource)
		{
			if (Array.isArray(dataSource))
			{
				dataName = camMessage.message.message.data.simpleItem[0].$.Name;
				dataValue = this.normalizeEventValue(camMessage.message.message.data.simpleItem[0].$.Value);
			}
			else
			{
				dataName = camMessage.message.message.data.simpleItem.$.Name;
				dataValue = this.normalizeEventValue(camMessage.message.message.data.simpleItem.$.Value);
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

		if (dataName && camMessage.message.message.key && camMessage.message.message.key.simpleItem)
		{
			objectId = camMessage.message.message.key.simpleItem.$.Value;
		}

		return {
			eventTopic,
			dataName,
			dataValue,
			objectId,
			compareSetting: dataName ? (eventTopic + ':' + dataName) : ''
		};
	}

	async handleMetricEvent(compareSetting, dataValue)
	{
		const metricHandler = EVENT_METRIC_HANDLERS[compareSetting];
		if (!metricHandler)
		{
			return false;
		}

		if (!(await this.ensureOptionalCapability(metricHandler.optionalCapability)))
		{
			return true;
		}

		const metricValue = metricHandler.transform ? metricHandler.transform(dataValue) : dataValue;
		this.setCapabilityValue(metricHandler.capability, metricValue).catch(this.error);

		return true;
	}

	routePrimaryMotionEvent(compareSetting, dataName, dataValue, objectId)
	{
		if ((compareSetting === this.eventTN) && this.isEventObjectIdEnabled(objectId))
		{
			this.triggerMotionEvent(dataName, dataValue).catch(this.err);
			return true;
		}

		return false;
	}

	routeLineCrossedEvent(dataValue)
	{
		if (!this.isEventObjectIdEnabled(dataValue))
		{
			return false;
		}

		this.triggerLineCrossedEvent(dataValue).catch(this.err);
		return true;
	}

	routeDarkImageEvent(dataValue)
	{
		this.triggerDarkImageEvent(dataValue).catch(this.err);
		return true;
	}

	routeSpecialCompareEvent(compareSetting, dataValue)
	{
		const specialHandler = this.eventSpecialHandlers[compareSetting];
		if (typeof specialHandler === 'function')
		{
			return specialHandler(dataValue);
		}

		return false;
	}

	routeCompareEvent(compareSetting, dataValue)
	{
		const compareHandler = this.eventCompareHandlers[compareSetting];
		if (typeof compareHandler === 'function')
		{
			compareHandler(dataValue).catch(this.err);
			return true;
		}

		return false;
	}

	routeTamperEvent(dataName, dataValue)
	{
		if (dataName === 'IsTamper')
		{
			this.triggerTamperEvent(dataName, dataValue).catch(this.err);
			return true;
		}

		return false;
	}

	async routeCamEvent(camEvent)
	{
		const {
			eventTopic,
			dataName,
			dataValue,
			objectId,
			compareSetting
		} = camEvent;

		if (!dataName)
		{
			return;
		}

		this.homey.app.updateLog('Event data: (' + this.name + ') ' + eventTopic + ': ' + dataName + ' = ' + dataValue + (objectId === '' ? '' : (' (' + objectId + ')')), 1, true);

		if (this.routePrimaryMotionEvent(compareSetting, dataName, dataValue, objectId))
		{
			return;
		}

		if (this.routeSpecialCompareEvent(compareSetting, dataValue))
		{
			return;
		}

		if (await this.handleMetricEvent(compareSetting, dataValue))
		{
			return;
		}

		if (this.routeCompareEvent(compareSetting, dataValue))
		{
			return;
		}

		if (this.routeTamperEvent(dataName, dataValue))
		{
			return;
		}

		this.homey.app.updateLog('Ignoring event type (' + this.name + ') ' + eventTopic + ': ' + dataName + ' = ' + dataValue);
	}

	getEventTN(settings, fromSetSettings)
	{
		const searchType = notificationMap[settings.notificationToUse];
		const availableTypes = settings.notificationTypes.split(',');

		// See if the required type is available
		if (Array.isArray(searchType) && availableTypes.some((type) => searchType.indexOf(type) >= 0))
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

		if (changedKeys.indexOf('userLiveUri') >= 0)
		{
			this.userLiveUri = newSettings.userLiveUri;
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
					this.homey.app.updateLog('unsubscribe error (' + this.name + '): ' + this.homey.app.varToString(err.message), 0);
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

		// Always resync optional capabilities on settings changes to avoid missed UI updates
		// when changedKeys does not include all toggles in some Homey flows.
		setImmediate(async () =>
		{
			this.notificationTypesUpdated(newSettings);
		});

		if (reconnect)
		{
			// re-connect to camera after exiting this callback
			setImmediate(() =>
			{
				this.connectCamera(false).catch(this.error);
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
						this.homey.app.updateLog('unsubscribe error (' + this.name + '): ' + this.homey.app.varToString(err.message), 0);
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
				const currentSettings = this.getSettings();
				const optionalSettingsInitialized = this.getStoreValue('optionalSettingsInitialized') === true;
				const supportedOptionalSettings = this.getSupportedOptionalEventSettings(supportedEvents);
				const unsupportedOptionalSettingsUpdate = optionalSettingsInitialized
					? {}
					: this.buildUnsupportedOptionalSettingsUpdate(currentSettings, supportedOptionalSettings);
				try
				{
					await this.setSettings(
						{
							'manufacturer': String(info.manufacturer || ''),
							'model': String(info.model || ''),
							'serialNumber': String(info.serialNumber || ''),
							'firmwareVersion': String(info.firmwareVersion || ''),
							'hasMotion': this.hasMotion,
							'notificationMethods': notificationMethods,
							'notificationTypes': supportedEvents.toString(),
							'hasSnapshot': Boolean(this.snapshotSupported),
							...unsupportedOptionalSettingsUpdate,
						});
				}
				catch (err)
				{
					this.homey.app.updateLog('Connect to camera set settings error (' + this.name + '): ' + err.message, 0);
				}

				if (!optionalSettingsInitialized)
				{
					try
					{
						await this.setStoreValue('optionalSettingsInitialized', true);
					}
					catch (err)
					{
						this.homey.app.updateLog('setStoreValue optionalSettingsInitialized error (' + this.name + '): ' + (err?.message || err), 0);
					}
				}

				const settingsForCapabilitySync = {
					...currentSettings,
					...unsupportedOptionalSettingsUpdate
				};
				await this.notificationTypesUpdated(settingsForCapabilitySync);

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

				// Fetch presets and stream URL in parallel — they are independent SOAP calls
				const [presetsResult, streamResult] = await Promise.allSettled([
					new Promise((resolve, reject) =>
					{
						this.cam.getPresets({}, (err, data) =>
						{
							if (err) reject(err);
							else resolve(data);
						});
					}),
					this.homey.app.getStreamURL(this.cam)
				]);

				// Handle stream URL result
				if (streamResult.status === 'fulfilled')
				{
					this.liveUri = `${streamResult.value.uri}`;
					try
					{
						await this.setSettings({ urlLive: this.liveUri });
					}
					catch (err)
					{
						this.homey.app.updateLog('Set stream URL setting error (' + this.name + '): ' + (err?.message || err), 0);
					}
				}
				else
				{
					this.homey.app.updateLog('Get stream URL error (' + this.name + '): ' + (streamResult.reason?.message || streamResult.reason), 0);
				}

				// Handle presets result
				let presets = null;
				if (presetsResult.status === 'fulfilled')
				{
					presets = presetsResult.value;
					if (presets && Object.keys(presets).length > 0)
					{
						// Presets are available, add capability if it doesn't exist
						if (!this.hasCapability('ptz_preset'))
						{
							await this.addCapability('ptz_preset');
							this.registerCapabilityListener('ptz_preset', this.onCapabilityPTZPreset.bind(this));
						}
						await this.updatePresets();
					}
					else
					{
						// No presets available, remove capability if it exists
						if (this.hasCapability('ptz_preset'))
						{
							await this.removeCapability('ptz_preset');
						}
					}
				}
				else
				{
					// Error while retrieving presets, remove capability
					const ptzErr = presetsResult.reason;
					if (this.hasCapability('ptz_preset'))
					{
						await this.removeCapability('ptz_preset');
					}
					const ptzErrMsg = (ptzErr?.message || '').toLowerCase();
					if (ptzErrMsg.includes('onvif item not found') || ptzErrMsg.includes('item not found'))
					{
						this.homey.app.updateLog(`No PTZ presets (${this.getLogDeviceLabel()}): camera reported none`, 1);
					}
				else
					{
						this.homey.app.updateLog(`No PTZ presets (${this.getLogDeviceLabel()}): ${ptzErr?.message || ptzErr}`, 0);
					}
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
			}
			catch (err)
			{
				if (!this.repairing)
				{
					const stageSuffix = err?.stage ? (' @ ' + err.stage) : '';
					const codeSuffix = err?.code ? (' [' + err.code + ']') : '';
					this.homey.app.updateLog('Connect to camera error (' + this.name + ')' + stageSuffix + codeSuffix + ': ' + (err?.message || this.homey.app.varToString(err)), 0);
					this.setUnavailable(err).catch(this.err);

					if (err?.stage === 'getSystemDateAndTime' && err?.code === 'ECONNRESET')
					{
						this.connectCooldownUntil = Date.now() + 60000;
						this.homey.app.updateLog('Connect to camera (' + this.name + '): ECONNRESET - pausing reconnect for 60s', 1);
					}
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
			if (this.connectCooldownUntil && Date.now() < this.connectCooldownUntil)
			{
				return;
			}
			this.connectCooldownUntil = 0;
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
					try { await this.setStoreValue('alarmTime', this.alarmTime); } catch (err) { this.homey.app.updateLog('setStoreValue alarmTime error: ' + (err?.message || err), 0); }
					this.setCapabilityValue('tamper_time', this.convertDate(this.alarmTime, this.getSettings(), false)).catch(this.error);
				}

				if ((errStr.indexOf('EHOSTUNREACH') >= 0) || (errStr.indexOf('ECONNREFUSED') >= 0))
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
				const uri = snapURL && typeof snapURL.uri === 'string' ? snapURL.uri : null;
				this.snapUri = uri;
				if (!uri || uri.indexOf('http') < 0)
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
			this.logSnapshotIssue(
				'invalid_snapshot_url',
				'Invalid Snapshot URL (' + this.getLogDeviceLabel() + '): camera did not return a snapshot URI',
				0,
				300000
			);
			return;
		}
		this.homey.app.updateLog('Event snapshot URL (' + this.getLogDeviceLabel() + '): ' + this.homey.app.varToString(this.snapUri).replace(this.password, 'YOUR_PASSWORD'));

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
							this.homey.app.updateLog('Snapshot error (' + this.getLogDeviceLabel() + '): ' + this.homey.app.varToString(err), 0);
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
			try { await this.setStoreValue('eventTime', this.eventTime); } catch (err) { this.homey.app.updateLog('setStoreValue eventTime error: ' + (err?.message || err), 0); }
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
					this.homey.app.updateLog('Event off timeout (' + this.name + ') channel ' + this.channel, 1);
				}, 180000);

				if (!settings.single || !this.getCapabilityValue('alarm_motion'))
				{
					// Alarm was off or allowed multiple triggers so check if the minmum on time is up
					if (this.eventMinTimeId == null)
					{
						//start the minimum on time
						this.eventMinTimeId = this.homey.setTimeout(() =>
						{
							this.homey.app.updateLog('Minimum event time elapsed (' + this.name + ') channel ' + this.channel, 1);
							this.eventMinTimeId = null;
							if (!this.lastState)
							{
								// The event has been turned off already
								this.setCapabilityValue('alarm_motion', false).catch(this.error);
								this.homey.app.updateLog('Turned off event alarm (' + this.name + ') channel ' + this.channel, 1);
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
						this.homey.app.updateLog('Turned off event alarm (' + this.name + ') channel ' + this.channel, 1);
					}
				}
				else
				{
					this.homey.app.updateLog('Event alarm switch off delayed for minimum time (' + this.name + ') channel ' + this.channel, 1);
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
				this.homey.app.updateLog('unsubscribe error (' + this.name + '): ' + this.homey.app.varToString(err.message), 0);
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
				try { await this.setStoreValue('alarmTime', this.alarmTime); } catch (err) { this.homey.app.updateLog('setStoreValue alarmTime error: ' + (err?.message || err), 0); }
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
		if (!(await this.ensureOptionalCapability('line_crossed')))
		{
			return;
		}

		this.setAvailable().catch(this.error);

		this.homey.app.updateLog('Event Processing (' + this.name + '):' + ObjectId);

		if (this.getCapabilityValue('alarm_line_crossed'))
		{
			// Already triggered so ignore
			this.homey.app.updateLog('Ignoring unchanged event (' + this.name + ') Line Crossed', 1);
			return;
		}

		this.setCapabilityValue('alarm_line_crossed', true).catch(this.error);

		this.triggerMotionEvent('Line Crossed', true).catch(this.err);
		this.driver.eventLineCrossedTrigger
			.trigger(this)
			.catch(this.error)
			.then(() => this.log('Triggered enable on'));

		// This event doesn't clear so set a timer to clear it
		this.homey.clearTimeout(this.lineCrossedTimeoutId);
		this.lineCrossedTimeoutId = this.homey.setTimeout(() =>
		{
			this.setCapabilityValue('alarm_line_crossed', false).catch(this.error);
			this.triggerMotionEvent('Line Crossed', false).catch(this.err);
			this.homey.app.updateLog('Line crossed off (' + this.name + ')', 1);
		}, 15000);

	}

	async triggerPersonEvent(dataValue)
	{
		if (!(await this.ensureOptionalCapability('person')))
		{
			return;
		}

		this.setAvailable().catch(this.error);

		this.homey.app.updateLog('Event Processing (' + this.name + '):' + dataValue);
		if (this.getCapabilityValue('alarm_person') !== dataValue)
		{
			// Only trigger if the state has changed
			this.triggerMotionEvent('Person Detected', dataValue).catch(this.err);

			this.setCapabilityValue('alarm_person', dataValue).catch(this.error);
		}

		this.homey.clearTimeout(this.personTimeoutId);
		if (dataValue)
		{
			this.driver.eventPersonTrigger
				.trigger(this)
				.catch(this.error)
				.then(() => this.log('Triggered enable on'));

			// If this event doesn't clear, set a timer to clear it
			this.personTimeoutId = this.homey.setTimeout(() =>
			{
				this.setCapabilityValue('alarm_person', false).catch(this.error);
				this.triggerMotionEvent('Person Detected', false).catch(this.err);
				this.homey.app.updateLog('Person Detected off (' + this.name + ')', 1);
			}, 15000);
		}
	}

	async triggerDogCatEvent(dataValue)
	{
		if (!(await this.ensureOptionalCapability('dog_cat')))
		{
			return;
		}

		this.setAvailable().catch(this.error);

		this.homey.app.updateLog('Event Processing (' + this.name + '):' + dataValue);
		// Only trigger if the state has changed
		if (this.getCapabilityValue('alarm_dog_cat') !== dataValue)
		{
			this.triggerMotionEvent('Dog / Cat Detected', dataValue).catch(this.err);

			this.setCapabilityValue('alarm_dog_cat', dataValue).catch(this.error);
		}

		// If this event doesn't clear, set a timer to clear it
		this.homey.clearTimeout(this.dogCatTimeoutId);
		if (dataValue)
		{
			this.driver.eventDogCatTrigger
				.trigger(this)
				.catch(this.error)
				.then(() => this.log('Triggered enable on'));

			this.dogCatTimeoutId = this.homey.setTimeout(() =>
			{
				this.setCapabilityValue('alarm_dog_cat', false).catch(this.error);
				this.triggerMotionEvent('Dog / Cat Detected', false).catch(this.err);
				this.homey.app.updateLog('Dog / Cat Detected off (' + this.name + ')', 1);
			}, 15000);
		}
	}

	async triggerVisitorEvent(dataValue)
	{
		if (!(await this.ensureOptionalCapability('visitor')))
		{
			return;
		}

		this.setAvailable().catch(this.error);

		this.homey.app.updateLog('Event Processing (' + this.name + '):' + dataValue);
		if (this.hasCapability('alarm_generic'))
		{
			if (this.getCapabilityValue('alarm_generic') !== dataValue)
			{
				this.triggerMotionEvent('Generic Detected', dataValue).catch(this.err);
				this.setCapabilityValue('alarm_generic', dataValue).catch(this.error);
			}
 		}

		// Only trigger if the state has changed
		if (this.getCapabilityValue('alarm_visitor') !== dataValue)
		{
			this.triggerMotionEvent('Visitor Detected', dataValue).catch(this.err);
			this.setCapabilityValue('alarm_visitor', dataValue).catch(this.error);
		}

		// If this event doesn't clear, set a timer to clear it
		this.homey.clearTimeout(this.visitorTimeoutId || this.vistorTimeoutId);
		if (dataValue)
		{
			this.homey.app.updateLog('Triggering event (' + this.name + ') Visitor Detected = ' + dataValue, 1);
			(this.driver.eventVisitorTrigger || this.driver.eventVistorTrigger)
				.trigger(this)
				.catch(this.error)
				.then(() => this.log('Triggered enable on'));

			this.visitorTimeoutId = this.homey.setTimeout(() =>
			{
				if (this.hasCapability('alarm_generic'))
				{
					this.setCapabilityValue('alarm_generic', dataValue).catch(this.error);
				}

				this.setCapabilityValue('alarm_visitor', false).catch(this.error);
				this.triggerMotionEvent('Visitor Detected', false).catch(this.err);
				this.homey.app.updateLog('Visitor Detected off (' + this.name + ')', 1);
			}, 15000);

			// Keep legacy property updated for backward compatibility in long-lived runtime state.
			this.vistorTimeoutId = this.visitorTimeoutId;
		}
	}

	async triggerVistorEvent(dataValue)
	{
		return this.triggerVisitorEvent(dataValue);
	}

	async triggerFaceEvent(dataValue)
	{
		if (!(await this.ensureOptionalCapability('face')))
		{
			return;
		}

		this.setAvailable().catch(this.error);

		this.homey.app.updateLog('Event Processing (' + this.name + '):' + dataValue);
		// Only trigger if the state has changed
		if (this.getCapabilityValue('alarm_face') !== dataValue)
		{
			this.triggerMotionEvent('Face Detected', dataValue).catch(this.err);

			this.setCapabilityValue('alarm_face', dataValue).catch(this.error);
		}

		// If this event doesn't clear, set a timer to clear it
		this.homey.clearTimeout(this.faceTimeoutId);
		if (dataValue)
		{
			this.driver.eventFaceTrigger
				.trigger(this)
				.catch(this.error)
				.then(() => this.log('Triggered enable on'));

			this.faceTimeoutId = this.homey.setTimeout(() =>
			{
				this.setCapabilityValue('alarm_face', false).catch(this.error);
				this.triggerMotionEvent('Face Detected', false).catch(this.err);
				this.homey.app.updateLog('Face Detected off (' + this.name + ')', 1);
			}, 15000);
		}
	}

	async triggerVehicleEvent(dataValue)
	{
		if (!(await this.ensureOptionalCapability('vehicle')))
		{
			return;
		}

		this.setAvailable().catch(this.error);

		this.homey.app.updateLog('Event Processing (' + this.name + '):' + dataValue);
		// Only trigger if the state has changed
		if (this.getCapabilityValue('alarm_vehicle') !== dataValue)
		{
			this.triggerMotionEvent('Vehicle Detected', dataValue).catch(this.err);
			this.setCapabilityValue('alarm_vehicle', dataValue).catch(this.error);

		}

		// If this event doesn't clear, set a timer to clear it
		this.homey.clearTimeout(this.vehicleTimeoutId);
		if (dataValue)
		{
			this.driver.eventVehicleTrigger
				.trigger(this)
				.catch(this.error)
				.then(() => this.log('Triggered enable on'));

			this.vehicleTimeoutId = this.homey.setTimeout(() =>
			{
				this.setCapabilityValue('alarm_vehicle', false).catch(this.error);
				this.triggerMotionEvent('Vehicle Detected', false).catch(this.err);
				this.homey.app.updateLog('Vehicle Detected off (' + this.name + ')', 1);
			}, 5000);
		}
	}

	async triggerDarkImageEvent(value)
	{
		if (!(await this.ensureOptionalCapability('dark_image')))
		{
			return;
		}

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
		if (this.isDeleting)
		{
			return;
		}

		if (this.getCapabilityValue('motion_enabled'))
		{
			if (this.shouldDropCameraEvent())
			{
				return;
			}

			this.activeEventHandlers += 1;
			try
			{
				this.homey.app.updateLog('\r\n--  Event detected (' + this.name + ')  --', 1);
				this.homey.app.updateLog(this.homey.app.varToString(camMessage));

				const camEvent = this.parseCamEvent(camMessage);
				if (!camEvent)
				{
					return;
				}

				this.setAvailable().catch(this.error);
				await this.routeCamEvent(camEvent);
			}
			catch (err)
			{
				this.homey.app.updateLog('Camera Event Error (' + this.name + '): ' + err.message, 0);
			}
			finally
			{
				this.activeEventHandlers = Math.max(0, this.activeEventHandlers - 1);
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

				this.homey.app.updateLog('onCapabilityMotionEnable (' + this.name + '): ' + value, 1);
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
						.then(() => this.log('Triggered enable on'));
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
						this.homey.app.updateLog(this.getName() + ' onCapabilityOff Error (' + this.name + ') ' + err.message, 0);
						return false;
					}

					this.driver.motionDisabledTrigger
						.trigger(this)
						.catch(this.error)
						.then(() => this.log('Triggered enable off'));
				}

				return true;

			}
			catch (err)
			{
				//this.setUnavailable();
				this.homey.app.updateLog(this.getName() + ' onCapabilityOnoff Error (' + this.name + ') ' + err.message, 0);
				return false;
			}
		}

		return false;
	}

	async setupImages()
	{

		if (!this.video)
		{
			if ((this.liveUri || this.userLiveUri) && (typeof this.homey.hasFeature === 'function') && this.homey.hasFeature('camera-streaming'))
			{
				this.homey.app.updateLog('Registering Live video stream (' + this.name + ')');
				this.video = await this.homey.videos.createVideoRTSP();
				this.video.registerVideoUrlListener(async () =>
				{
					let newUrl = this.userLiveUri;

					if (!newUrl)
					{
						// Use ONVIF stream URL
						// let reply = await this.homey.app.getStreamURL(this.cam);
						// newUrl = `${reply.uri}`;
						newUrl = this.liveUri;
					}

					this.homey.app.updateLog(`Live video stream to URL: ${newUrl}`);

					// If the url doesn't contain user=<username> then add it
					if (!newUrl.includes(`user=${this.username}`))
					{
						// insert the username and password just after the protocol in the format [username:password@<host>]
						// URL encode username and password
						const auth = encodeURIComponent(this.username) + ':' + encodeURIComponent(this.password) + '@';

						const host = newUrl.split('/')[2];
						newUrl = newUrl.replace(host, auth + host);
					}

					this.homey.app.updateLog(`Setting Live video stream to ${newUrl}`);
					return { url: newUrl };
				});
				this.setCameraVideo('NowVideo', 'Live Video', this.video).catch(this.err);
				this.homey.app.updateLog('registered Live video stream (' + this.name + ')');
			}
			else
			{
				if (!this.liveUri && !this.userLiveUri)
				{
					this.homey.app.updateLog('Live video streams require a valid stream URL', 0);
				}
				else if (!this.homey.app.checkSymVersionGreaterEqual(this.homey.version, 12, 7, 1))
				{
					this.homey.app.updateLog('Live video streams require Homey 2023 v12.7.1 or higher', 0);
				}
				else if (!this.homey.hasFeature('camera-streaming'))
				{
					this.homey.app.updateLog('Live video streams require a Homey Pro 2023 or later', 0);
				}
			}
		}

		// Setup snapshot images
		// If snapshot is not supported and no user defined snapshot URL then skip this
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
				const uri = snapURL && typeof snapURL.uri === 'string' ? snapURL.uri : null;
				if (!uri || uri.indexOf('http') < 0)
				{
					this.snapUri = null;
					this.logSnapshotIssue(
						'invalid_snapshot_url',
						uri ? ('Invalid Snapshot URL (' + this.getLogDeviceLabel() + '), it must be http or https: ' + this.homey.app.varToString(uri).replace(this.password, 'YOUR_PASSWORD')) : ('Invalid Snapshot URL (' + this.getLogDeviceLabel() + '): camera did not return a snapshot URI'),
						0,
						300000
					);
					return;
				}

				this.snapUri = uri;
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
							this.homey.app.updateLog('Fetch NOW error (' + this.getLogDeviceLabel() + '): ' + res.statusText, 0);
							this.setWarning(res.statusText);
							throw new Error(res.statusText);
						}

						res.body.pipe(stream);

						stream.on('error', (err) =>
						{
							this.homey.app.updateLog('Fetch Now image error (' + this.getLogDeviceLabel() + '): ' + err.message, 0);
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
				this.homey.app.updateLog('SnapShot nowImage error (' + this.getLogDeviceLabel() + ') = ' + err.message, 0);
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
						this.homey.app.updateLog('Fetch MOTION error (' + this.getLogDeviceLabel() + '): ' + this.homey.app.varToString(res), 0);
						this.updatingEventImage = false;
						throw new Error(res.statusText);
					}

					res.body.pipe(storageStream);

					storageStream.on('error', (err) =>
					{
						this.homey.app.updateLog('Fetch event image error (' + this.getLogDeviceLabel() + '): ' + err.message, true);
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
				this.homey.app.updateLog('Event SnapShot error (' + this.getLogDeviceLabel() + '): ' + err.message, 0);
				this.updatingEventImage = false;
			}
		}
		catch (err)
		{
			//this.homey.app.updateLog("SnapShot error: " + this.homey.app.varToString(err), true);
			this.homey.app.updateLog('SnapShot error (' + this.getLogDeviceLabel() + '): ' + err.message, 0);
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
					res = await fetch(this.snapUri, { agent: agent, timeout: 10000 });
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
				this.logSnapshotFetchError(err, name);
				// Try Basic Authentication
				this.authType = 1;

				res = {
					'ok': false,
					'statusText': err.code || err.message || 'snapshot_fetch_failed'
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
					res = await client.fetch(this.snapUri, { agent: agent, timeout: 10000 });
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
				this.logSnapshotFetchError(err, name);
				// Try Digest Authentication
				this.authType = 2;

				res = {
					'ok': false,
					'statusText': err.code || err.message || 'snapshot_fetch_failed'
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
					res = await client.fetch(this.snapUri, { agent: agent, timeout: 10000 });
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
				this.logSnapshotFetchError(err, name);

				// Go back to no Authentication
				this.authType = 0;

				res = {
					'ok': false,
					'statusText': err.code || err.message || 'snapshot_fetch_failed'
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
			this.isDeleting = true;
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
				if (fs.existsSync(eventImagePath))
				{
					fs.unlink(eventImagePath, (err) =>
					{
						if (err)
						{
							this.homey.app.updateLog('Delete event image error (' + this.name + '): ' + err.message, 0);
						}
					});
				}
			}
			this.homey.app.updateLog('Delete device (' + this.name + ')', 1);
		}
		catch (err)
		{
			this.homey.app.updateLog('Delete device error (' + this.name + '): ' + err.message, 0);
		}
	}

	clearTimers()
	{
		this.homey.clearTimeout(this.checkTimerId);
		this.checkTimerId = null;
		this.homey.clearTimeout(this.eventTimerId);
		this.eventTimerId = null;
		this.homey.clearTimeout(this.eventMinTimeId);
		this.eventMinTimeId = null;
		this.homey.clearTimeout(this.eventTimeoutId);
		this.eventTimeoutId = null;
		this.homey.clearTimeout(this.lineCrossedTimeoutId);
		this.lineCrossedTimeoutId = null;
		this.homey.clearTimeout(this.personTimeoutId);
		this.personTimeoutId = null;
		this.homey.clearTimeout(this.dogCatTimeoutId);
		this.dogCatTimeoutId = null;
		this.homey.clearTimeout(this.visitorTimeoutId);
		this.visitorTimeoutId = null;
		this.homey.clearTimeout(this.vistorTimeoutId);
		this.vistorTimeoutId = null;
		this.homey.clearTimeout(this.faceTimeoutId);
		this.faceTimeoutId = null;
		this.homey.clearTimeout(this.vehicleTimeoutId);
		this.vehicleTimeoutId = null;
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
			this.homey.app.updateLog(`No PTZ presets available for ${this.getLogDeviceLabel()}`, 0);
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