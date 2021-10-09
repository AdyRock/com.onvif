/*jslint node: true */
'use strict';

const Homey = require('homey');
const DigestFetch = require('/lib/digest-fetch');
const fetch = require('node-fetch');
const fs = require('fs');
const
{
    isArray
} = require('util');

const notificationMap = {
    "RuleEngine/CellMotionDetector/Motion:IsMotion": ["MOTION"],
    "RuleEngine/FieldDetector/ObjectsInside:IsInside": ["ANALYTICSSERVICE", "OBJECTSINSIDE"],
    "VideoSource/MotionAlarm:State": ["MOTIONALARM"],
    "Device/Trigger/DigitalInput:LogicalState": ["DIGITALINPUT"]
};

class CameraDevice extends Homey.Device
{

    async onInit()
    {
        this.repairing = false;
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

        // Upgrade old device settings where the ip and port where part of the data
        const settings = this.getSettings();
        const devData = this.getData();
        if (typeof settings.ip === "undefined")
        {
            await this.setSettings(
            {
                'ip': devData.id,
                'port': devData.port.toString()
            });
        }

        if (settings.notificationTypes.indexOf('CROSSED') >= 0)
        {
            if (!this.hasCapability('alarm_line_crossed'))
            {
                this.addCapability('alarm_line_crossed');
            }
            this.setCapabilityValue('alarm_line_crossed', false).catch(this.error);
        }
        else
        {
            if (this.hasCapability('alarm_line_crossed'))
            {
                this.removeCapability('alarm_line_crossed');
            }
        }

        if (settings.notificationTypes.indexOf('IMAGINGSERVICE') >= 0)
        {
            if (!this.hasCapability('alarm_dark_image'))
            {
                this.addCapability('alarm_dark_image');
            }
        }
        else
        {
            if (this.hasCapability('alarm_dark_image'))
            {
                this.removeCapability('alarm_dark_image');
            }
        }

        if (settings.notificationTypes.indexOf('STORAGEFAILURE') >= 0)
        {
            if (!this.hasCapability('alarm_storage'))
            {
                this.addCapability('alarm_storage');
            }
        }
        else
        {
            if (this.hasCapability('alarm_storage'))
            {
                this.removeCapability('alarm_storage');
            }
        }

        if (settings.notificationTypes.indexOf('PROCESSORUSAGE') >= 0)
        {
            if (!this.hasCapability('measure_cpu'))
            {
                this.addCapability('measure_cpu');
            }
        }
        else
        {
            if (this.hasCapability('measure_cpu'))
            {
                this.removeCapability('measure_cpu');
            }
        }

        this.preferPullEvents = settings.preferPullEvents;
        this.hasMotion = settings.hasMotion;
        if (typeof settings.channel === "undefined")
        {
            await this.setSettings(
            {
                'channel': -1
            });
        }

        if (typeof settings.token === "undefined")
        {
            await this.setSettings(
            {
                'token': ""
            });
        }

        this.enabled = settings.enabled;
        this.password = settings.password;
        this.username = settings.username;
        this.ip = settings.ip;
        this.port = settings.port;
        this.channel = settings.channel;
        this.token = settings.token;
        this.userSnapUri = settings.userSnapUri;
        this.eventTN = this.getEventTN(settings, false);
        this.eventObjectID = settings.objectID;
        if (this.eventTN !== "RuleEngine/FieldDetector/ObjectsInside:IsInside")
        {
            this.eventObjectID = "";
        }
        else if (this.eventObjectID !== "")
        {
            this.eventObjectID = this.eventObjectID.split(",");
        }

        this.id = devData.id;
        this.name = this.getName();
        Homey.app.updateLog("Initialising CameraDevice (" + this.name + ")");

        if (this.hasCapability('alarm_motion'))
        {
            this.setCapabilityValue('alarm_motion', false).catch(this.error);
        }

        let requiredClass = settings.classType;
        if (this.getClass() != requiredClass)
        {
            this.setClass(requiredClass);
        }

        this.connectCamera(false)
            .catch(err =>
            {
                Homey.app.updateLog("Check Camera Error (" + this.name + "): " + Homey.app.varToString(err), 0);
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

        this.registerCapabilityListener('button.syncTime', async () =>
        {
            // Set the Camera date to Homey's date
            Homey.app.updateLog("Syncing time (" + this.name + ")");

            Date.prototype.stdTimezoneOffset = function()
            {
                var jan = new Date(this.getFullYear(), 0, 1);
                var jul = new Date(this.getFullYear(), 6, 1);
                return Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
            };

            Date.prototype.isDstObserved = function()
            {
                return this.getTimezoneOffset() < this.stdTimezoneOffset();
            };

            try
            {
                var d = new Date();
                var dls = d.isDstObserved();

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
                            Homey.app.updateLog("Check Camera Error (" + this.name + "): " + Homey.app.varToString(err), 0);
                        }
                    });
            }
            catch (err)
            {
                Homey.app.updateLog("Check Camera Error (" + this.name + "): " + Homey.app.varToString(err), 0);
            }
        });
    }

    async onAdded()
    {
        Homey.app.updateLog('CameraDevice has been added (' + this.name + ')');
        //Allow some time for the validation check cam connection to disconnect
        // await new Promise(resolve => setTimeout(resolve, 2000));
        // await this.getDriver().getLastCredentials(this);
        // this.connectCamera(true)
        //     .catch(this.error);
    }

    getEventTN(settings, fromSetSettings)
    {
        const searchType = notificationMap[settings.notificationToUse];
        const availableTypes = settings.notificationTypes.split(",");

        // See if the required type is available
        if (availableTypes.map(function(type) { return searchType.indexOf(type);}))
//        if (availableTypes.indexOf(searchType) >= 0)
        {
            return settings.notificationToUse;
        }

        if (fromSetSettings)
        {
            throw (new Error("Sorry the notification method you have chosen to use is not supported by this camera."));
        }

        // Not available so try MOTION
        if (availableTypes.indexOf("MOTION") >= 0)
        {
            return "RuleEngine/CellMotionDetector/Motion:IsMotion";
        }

        return "VideoSource/MotionAlarm:State";
    }

    async onRenamed(newName)
    {
        this.name = newName;
    }

    async onSettings(oldSettingsObj, newSettingsObj, changedKeysArr)
    {
        let reconnect = false;

        if (changedKeysArr.indexOf("notificationToUse") >= 0)
        {
            this.eventTN = this.getEventTN(newSettingsObj, true);
        }

        if (changedKeysArr.indexOf("objectID") >= 0)
        {
            this.eventObjectID = newSettingsObj.objectID;
        }
        else
        {
            this.eventObjectID = oldSettingsObj.objectID;
        }

        if (this.eventTN !== "RuleEngine/FieldDetector/ObjectsInside:IsInside")
        {
            this.eventObjectID = "";
        }
        else if (this.eventObjectID !== "")
        {
            this.eventObjectID = this.eventObjectID.split(",");
        }

        if (changedKeysArr.indexOf("enabled") >= 0)
        {
            this.enabled = newSettingsObj.enabled;
            reconnect = true;
        }

        if (changedKeysArr.indexOf("username") >= 0)
        {
            this.username = newSettingsObj.username;
            reconnect = true;
        }

        if (changedKeysArr.indexOf("password") >= 0)
        {
            this.password = newSettingsObj.password;
            reconnect = true;
        }

        if (changedKeysArr.indexOf("ip") >= 0)
        {
            this.ip = newSettingsObj.ip;
            reconnect = true;
        }

        if (changedKeysArr.indexOf("port") >= 0)
        {
            this.port = newSettingsObj.port;
            reconnect = true;
        }

        if (changedKeysArr.indexOf("timeFormat") >= 0)
        {
            this.setCapabilityValue('event_time', this.convertDate(this.eventTime, newSettingsObj)).catch(this.error);
            this.setCapabilityValue('tamper_time', this.convertDate(this.alarmTime, newSettingsObj)).catch(this.error);
            this.setCapabilityValue('date_time', this.convertDate(this.cameraTime, newSettingsObj)).catch(this.error);
        }

        if (changedKeysArr.indexOf("channel") >= 0)
        {
            this.channel = newSettingsObj.channel;
            if (!reconnect)
            {
                // refresh image settings after exiting this callback
                setImmediate(() =>
                {
                    this.setupImages();
                    return;
                });
            }
        }

        if (changedKeysArr.indexOf("hasSnapshot") >= 0)
        {
            this.snapshotSupported = newSettingsObj.hasSnapshot;
        }

        if (changedKeysArr.indexOf("userSnapUri") >= 0)
        {
            this.userSnapUri = newSettingsObj.userSnapUri;
            if (!reconnect)
            {
                // refresh image settings after exiting this callback
                setImmediate(() =>
                {
                    this.setupImages();
                    return;
                });
            }
        }

        if (changedKeysArr.indexOf("preferPullEvents") >= 0)
        {
            // Changing preferred event method
            this.preferPullEvents = newSettingsObj.preferPullEvents;
            if (this.hasMotion && this.getCapabilityValue('motion_enabled'))
            {
                // Switch off the current even mode
                await Homey.app.unsubscribe(this);

                if (!reconnect)
                {
                    // Turn on the new mode
                    setImmediate(() =>
                    {
                        this.listenForEvents(this.cam);
                        return;
                    });
                }
            }
        }

        if (changedKeysArr.indexOf("classType") >= 0)
        {
            this.setClass(newSettingsObj.classType);
        }

        if (reconnect)
        {
            // re-connect to camera after exiting this callback
            setImmediate(() =>
            {
                this.connectCamera(false);
                return;
            });
        }
    }

    async connectCamera(addingCamera)
    {
        if (!this.enabled)
        {
            if (this.cam)
            {
                clearTimeout(this.checkTimerId);
                clearTimeout(this.eventSubscriptionRenewTimerId);
                clearTimeout(this.eventTimerId);
                if (this.cam)
                {
                    //Stop listening for motion events
                    this.cam.removeAllListeners('event');

                    await Homey.app.unsubscribe(this);
                }
                this.cam = null;
            }

            this.setUnavailable("Camera is disabled in Advanced Settings");

            return;
        }

        if (this.repairing)
        {
            // Wait while repairing and try again later
            this.checkTimerId = setTimeout(this.connectCamera.bind(this, addingCamera), 2000);
        }
        else
        {
            try
            {
                this.cam = await Homey.app.connectCamera(
                    this.ip,
                    this.port,
                    this.username,
                    this.password
                );

                this.cam.on('error', (msg, xml) =>
                {
                    Homey.app.updateLog("Global Camera event error (" + this.name + "): " + Homey.app.varToString(msg), 0);
                    if (xml)
                    {
                        Homey.app.updateLog("xml: " + Homey.app.varToString(xml), 3);
                    }
                });

                this.supportPushEvent = false;
                try
                {
                    let capabilities = await Homey.app.getServiceCapabilities(this.cam);
                    Homey.app.updateLog("** service capabilities " + this.name + " = " + capabilities);

                    let services = await Homey.app.getServices(this.cam);
                    if (Array.isArray(services))
                    {
                        services.forEach((service) =>
                        {
                            if (service.namespace.search('.org/') > 0)
                            {
                                let namespaceSplitted = service.namespace.split('.org/')[1].split('/');
                                if ((namespaceSplitted[1] == 'events') && service.capabilities && service.capabilities.capabilities)
                                {
                                    let serviceCapabilities = service.capabilities.capabilities.$;
                                    if (serviceCapabilities.MaxNotificationProducers > 0)
                                    {
                                        this.supportPushEvent = true;
                                        Homey.app.updateLog("** PushEvent supported on " + this.name);
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
                                            Homey.app.updateLog("** Snapshots are supported on " + this.name);
                                        }
                                        else
                                        {
                                            Homey.app.updateLog("** Snapshots NOT supported on " + this.name, this.snapshotSupported, 0);
                                        }
                                    }
                                }
                                if (namespaceSplitted[1] == 'analytics')
                                {
                                    this.supportPushEvent = true;
                                    Homey.app.updateLog("** Analytics supported on " + this.name);
                                }
                            }
                            else
                            {
                                Homey.app.updateLog("getServices: Unrecognised namespace for service " + service);
                            }
                        });
                    }
                }
                catch (err)
                {
                    Homey.app.updateLog("Get camera services error (" + this.name + "): " + err.stack, 0);
                }

                //if (addingCamera) {
                let info = {};
                try
                {
                    info = await Homey.app.getDeviceInformation(this.cam);
                    Homey.app.updateLog("Camera Information (" + this.name + "): " + Homey.app.varToString(info, ));
                }
                catch (err)
                {
                    Homey.app.updateLog("Get camera info error (" + this.name + "): " + err.stack, 0);
                }

                let supportedEvents = [""];
                try
                {
                    let capabilities = await Homey.app.getCapabilities(this.cam);
                    this.hasPullPoints = Homey.app.hasPullSupport(capabilities, this.name);
                    if (this.hasPullPoints || this.supportPushEvent)
                    {
                        supportedEvents = await Homey.app.hasEventTopics(this.cam);
                    }
                }
                catch (err)
                {
                    Homey.app.updateLog("Get camera capabilities error (" + this.name + "): " + err.stack, 0);
                }
                Homey.app.updateLog("Supported Events(" + this.name + "): " + supportedEvents);

                let notificationMethods = "";
                if (this.supportPushEvent && this.hasPullPoints)
                {
                    notificationMethods = Homey.__("Push_Pull_Supported"); //"Push and Pull supported: ";
                    if (this.preferPullEvents)
                    {
                        notificationMethods += Homey.__("Using_Pull"); //"Using Pull";
                    }
                    else
                    {
                        notificationMethods += Homey.__("Using_Push"); //"Using Push";
                    }
                }
                else if (this.hasPullPoints)
                {
                    notificationMethods += Homey.__("Only_Pull_Supported"); //"Only Pull supported";
                }
                else if (this.supportPushEvent)
                {
                    notificationMethods += Homey.__("OnlyPush_Supported"); // "Only Push supported";
                }
                else
                {
                    notificationMethods = Homey.__("Not_Supported"); //"Not supported";
                }

                this.hasMotion = ((supportedEvents.indexOf('MOTION') >= 0) && (this.hasPullPoints || this.supportPushEvent));
                await this.setSettings(
                {
                    "manufacturer": info.manufacturer,
                    "model": info.model,
                    "serialNumber": info.serialNumber.toString(),
                    "firmwareVersion": info.firmwareVersion,
                    "hasMotion": this.hasMotion,
                    'notificationMethods': notificationMethods,
                    'notificationTypes': supportedEvents.toString(),
                    'hasSnapshot': this.snapshotSupported,
                });

                let settings = this.getSettings();

                if (!this.hasMotion)
                {
                    Homey.app.updateLog("Removing unsupported motion capabilities for " + this.name);

                    if (this.hasCapability('motion_enabled'))
                    {
                        this.removeCapability('motion_enabled');
                    }
                    if (this.hasCapability('alarm_motion'))
                    {
                        this.removeCapability('alarm_motion');
                    }
                    if (this.hasCapability('event_time'))
                    {
                        this.removeCapability('event_time');
                    }
                }
                else
                {
                    if (!this.hasCapability('motion_enabled'))
                    {
                        this.addCapability('motion_enabled');
                    }
                    if (!this.hasCapability('alarm_motion'))
                    {
                        this.addCapability('alarm_motion');
                    }
                    if (!this.hasCapability('event_time'))
                    {
                        this.addCapability('event_time');
                    }
                }

                addingCamera = false;
                //}
                await this.setupImages();

                if (this.hasMotion)
                {
                    if (this.getCapabilityValue('motion_enabled'))
                    {
                        // Motion detection is enabled so listen for events
                        this.listenForEvents(this.cam);
                    }
                }

                this.setAvailable();
                this.isReady = true;
                this.setCapabilityValue('alarm_tamper', false).catch(this.error);
                Homey.app.updateLog("Camera (" + this.name + ") is ready");
            }
            catch (err)
            {
                if (!this.repairing)
                {
                    Homey.app.updateLog("Connect to camera error (" + this.name + "): " + err.stack, 0);
                    this.setUnavailable();
                }
                this.checkTimerId = setTimeout(this.connectCamera.bind(this, addingCamera), 5000);
                this.setCapabilityValue('alarm_tamper', false).catch(this.error);
            }
        }
    }

    async checkCamera()
    {
        if (this.enabled && !this.repairing && this.isReady && (parseInt(Homey.ManagerSettings.get('logLevel')) < 2))
        {
            try
            {
                let date = await Homey.app.getDateAndTime(this.cam);
                if (this.getCapabilityValue('alarm_tamper'))
                {
                    Homey.app.updateLog("Check Camera (" + this.name + "): back online", 1);
                    this.setCapabilityValue('alarm_tamper', false).catch(this.error);
                    this.setAvailable();

                    if (this.hasMotion && this.getCapabilityValue('motion_enabled'))
                    {
                        //Restart event monitoring
                        await Homey.app.unsubscribe(this);
                        setImmediate(() =>
                        {
                            this.listenForEvents(this.cam);
                            return;
                        });
                    }
                }
                else
                {
                    this.setAvailable();
                    this.cameraTime = date;
                    this.setCapabilityValue('date_time', this.convertDate(this.cameraTime, this.getSettings())).catch(this.error);

                    if (!this.snapUri)
                    {
                        await this.setupImages();
                    }
                }
            }
            catch (err)
            {
                let errStr = String(err);
                Homey.app.updateLog("Check Camera Error (" + this.name + "): " + Homey.app.varToString(errStr), 0);

                if (!this.getCapabilityValue('alarm_tamper'))
                {
                    this.setCapabilityValue('alarm_tamper', true).catch(this.error);
                    this.alarmTime = new Date(Date.now());
                    this.setStoreValue('alarmTime', this.alarmTime);
                    this.setCapabilityValue('tamper_time', this.convertDate(this.alarmTime, this.getSettings())).catch(this.error);
                }

                if (errStr.indexOf("EHOSTUNREACH") >= 0)
                {
                    this.setUnavailable();
                    await Homey.app.unsubscribe(this);
                }
            }
        }
    }

    convertDate(date, settings)
    {
        var strDate = "";
        if (date)
        {
            var d = new Date(date);

            if (settings.timeFormat == "mm_dd")
            {
                let mins = d.getMinutes();
                let dte = d.getDate();
                let mnth = d.getMonth() + 1;
                strDate = d.getHours() + ":" + (mins < 10 ? "0" : "") + mins + " " + (dte < 10 ? "0" : "") + dte + "-" + (mnth < 10 ? "0" : "") + mnth;
            }
            else if (settings.timeFormat == "system")
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
            const snapURL = await Homey.app.getSnapshotURL(this.cam);
            this.snapUri = snapURL.uri;
            if (snapURL.uri.indexOf("http") < 0)
            {
                this.snapUri = null;
            }
        }

        if (!this.snapUri)
        {
            Homey.app.updateLog("Invalid Snapshot URL, it must be http or https: " + Homey.app.varToString(this.snapURL.uri).replace(this.password, "YOUR_PASSWORD"), 0);
            return;
        }
        Homey.app.updateLog("Event snapshot URL (" + this.name + "): " + Homey.app.varToString(this.snapUri).replace(this.password, "YOUR_PASSWORD"));

        var res = await this.doFetch("MOTION EVENT");
        if (!res.ok)
        {
            Homey.app.updateLog(Homey.app.varToString(res));
            throw new Error(res.statusText);
        }

        return new Promise((resolve, reject) =>
        {
            const storageStream = fs.createWriteStream(Homey.app.getUserDataPath(this.eventImageFilename));

            res.body.pipe(storageStream);
            storageStream.on('error', (err) =>
            {
                Homey.app.updateLog(Homey.app.varToString(err));
                return reject(err);
                //throw new Error(err);
            });
            storageStream.on('finish', () =>
            {
                this.eventImage.update();
                Homey.app.updateLog("Event Image Updated (" + this.name + ")", 1);

                let tokens = {
                    'eventImage': this.eventImage
                };

                this.eventShotReadyTrigger
                    .trigger(this, tokens)
                    .catch(err =>
                    {
                        Homey.app.updateLog("Snapshot error (" + this.name + "): " + Homey.app.varToString(err), 0);
                        return reject(err);
                    })
                    .then(() =>
                    {
                        return resolve(true);
                    });
            });
        });
    }

    async updateMotionImage(delay)
    {
        if (!this.updatingEventImage)
        {
            const settings = this.getSettings();
            Homey.app.updateLog("Updating Motion Image in " + settings.delay + "seconds", 1);

            this.updatingEventImage = true;

            // Safeguard against flag not being reset for some reason
            let timerId = setTimeout(() =>
            {
                this.updatingEventImage = false;
            }, delay * 1000 + 20000);

            this.eventTime = new Date(Date.now());
            this.setStoreValue('eventTime', this.eventTime);
            this.setCapabilityValue('event_time', this.convertDate(this.eventTime, settings)).catch(this.error);
            if (this.snapshotSupported)
            {
                if (delay > 0)
                {
                    await new Promise(resolve => setTimeout(resolve, delay * 1000));
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
                        Homey.app.updateLog("Event image error (" + this.name + "): " + err, 0);
                        clearTimeout(timerId);
                        timerId = setTimeout(() =>
                        {
                            this.updatingEventImage = false;
                        }, 20000);
                    }
                }
            }
            else
            {
                Homey.app.updateLog("Snapshot not supported (" + this.name + ")", 1);
            }
            this.updatingEventImage = false;
            return true;
        }
        else
        {
            Homey.app.updateLog("** Event STILL Processing last image (" + this.name + ") **", 0);
            return false;
        }
    }

    async triggerMotionEvent(dataName, dataValue)
    {
        this.setAvailable();

        if (this.getCapabilityValue('motion_enabled'))
        {
            const settings = this.getSettings();
            this.lastState = dataValue;

            Homey.app.updateLog("Event Trigger (" + this.name + "):" + dataName + " = " + dataValue, 1);

            if (dataValue)
            {
                // Motion detected so set a timer to clear the motion in case we miss the off event
                clearTimeout(this.eventTimeoutId);
                this.eventTimeoutId = setTimeout(() =>
                {
                    this.setCapabilityValue('alarm_motion', false).catch(this.error);
                    console.log("Event off timeout");
                }, 180000);

                if (!settings.single || !this.getCapabilityValue('alarm_motion'))
                {
                    // Alarm was off or allowed multiple triggers so check if the minmum on time is up
                    if (this.eventMinTimeId == null)
                    {
                        //start the minimum on time
                        this.eventMinTimeId = setTimeout(() =>
                        {
                            console.log("Minimum event time elapsed");
                            this.eventMinTimeId = null;
                            if (!this.lastState)
                            {
                                // The event has been turned off already
                                this.setCapabilityValue('alarm_motion', false).catch(this.error);
                                console.log("Turned off event alarm");
                            }
                        }, settings.on_time * 1000);

                        this.setCapabilityValue('alarm_motion', true).catch(this.error);
                        await this.updateMotionImage(settings.delay);
                    }
                    else
                    {
                        Homey.app.updateLog("Ignoring event, too soon (" + this.name + ") " + dataName, 1);
                    }
                }
                else
                {
                    Homey.app.updateLog("Ignoring unchanged event (" + this.name + ") " + dataName + " = " + dataValue, 1);
                }
            }
            else
            {
                if (this.eventMinTimeId == null)
                {
                    // Minimum time has elapsed so switch the alarm of now
                    this.setCapabilityValue('alarm_motion', false).catch(this.error);
                    console.log("Turned off event alarm", 1);
                }
                else
                {
                    console.log("Event alarm switch off delayed for minimum time", 1);
                }
                clearTimeout(this.eventTimeoutId);
            }
        }
    }

    async triggerTamperEvent(dataName, dataValue)
    {
        const settings = this.getSettings();
        this.setAvailable();

        if (dataValue != this.getCapabilityValue('alarm_tamper'))
        {
            Homey.app.updateLog("Event Processing (" + this.name + "):" + dataName + " = " + dataValue);
            this.setCapabilityValue('alarm_tamper', dataValue).catch(this.error);
            if (dataValue)
            {
                this.alarmTime = new Date(Date.now());
                this.setStoreValue('alarmTime', this.alarmTime);
                this.setCapabilityValue('tamper_time', this.convertDate(this.alarmTime, this.getSettings())).catch(this.error);
            }
        }
        else
        {
            Homey.app.updateLog("Ignoring unchanged event (" + this.name + ") " + dataName + " = " + dataValue);
        }
    }

    async triggerLineCrossedEvent(ObjectId)
    {
        const settings = this.getSettings();
        this.setAvailable();

        Homey.app.updateLog("Event Processing (" + this.name + "):" + ObjectId);
        this.setCapabilityValue('alarm_line_crossed', true).catch(this.error);

        this.triggerMotionEvent('Line Crossed', true);

        // This event doesn't clear so set a timer to clear it
        clearTimeout(this.lineCrossedTimeoutId);
        this.lineCrossedTimeoutId = setTimeout(() =>
        {
            this.setCapabilityValue('alarm_line_crossed', false).catch(this.error);
            this.triggerMotionEvent('Line Crossed', false);
            console.log("Line crossed off");
        }, 5000);

    }

    async triggerDarkImageEvent(value)
    {
        const settings = this.getSettings();
        this.setAvailable();

        Homey.app.updateLog("Event Processing (" + this.name + "):" + value);
        this.setCapabilityValue('alarm_dark_image', value).catch(this.error);
    }

    async listenForEvents(cam_obj)
    {
        if (cam_obj)
        { //Stop listening for motion events before we add a new listener
            cam_obj.removeAllListeners('event');

            this.log("listenForEvents");

            if (this.updatingEventImage)
            {

                this.log("listenForEvents blocked bu updating image");

                // Wait while repairing and try again later
                this.eventTimerId = setTimeout(this.listenForEvents.bind(this, cam_obj), 2000);
            }
            else
            {
                if (this.supportPushEvent && !this.preferPullEvents)
                {
                    Homey.app.updateLog('\r\n## registering Push events (' + this.name + ') ##');

                    try
                    {
                        await Homey.app.subscribeToCamPushEvents(this);
                        Homey.app.updateLog('\r\n## Waiting for Push events (' + this.name + ') ##');
                    }
                    catch (error)
                    {
                        Homey.app.updateLog('\r\n## FAILED to register Push events (' + this.name + ') ##', 0);
                    }
                    return;
                }

                Homey.app.updateLog('## Waiting for Pull events (' + this.name + ') ##');
                cam_obj.on('event', (camMessage, xml) =>
                {
                    this.processCamEventMessage(camMessage);
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
                Homey.app.updateLog('\r\n--  Event detected (' + this.name + ')  --');
                Homey.app.updateLog(Homey.app.varToString(camMessage));

                this.setAvailable();

                let eventTopic = camMessage.topic._;
                eventTopic = Homey.app.stripNamespaces(eventTopic);

                let dataName = "";
                let dataValue = "";
                let objectId = "";

                // DATA (Name:Value)
                if (camMessage.message.message.data && camMessage.message.message.data.simpleItem)
                {
                    if (Array.isArray(camMessage.message.message.data.simpleItem))
                    {
                        for (let x = 0; x < camMessage.message.message.data.simpleItem.length; x++)
                        {
                            dataName = camMessage.message.message.data.simpleItem[x].$.Name;
                            dataValue = camMessage.message.message.data.simpleItem[x].$.Value;
                        }
                    }
                    else
                    {
                        dataName = camMessage.message.message.data.simpleItem.$.Name;
                        dataValue = camMessage.message.message.data.simpleItem.$.Value;
                    }
                }
                else if (camMessage.message.message.data && camMessage.message.message.data.elementItem)
                {
                    Homey.app.updateLog("WARNING: Data contain an elementItem", 0);
                    dataName = 'elementItem';
                    dataValue = Homey.app.varToString(camMessage.message.message.data.elementItem);
                }
                else
                {
                    Homey.app.updateLog("WARNING: Data does not contain a simpleItem or elementItem", 0);
                    dataName = null;
                    dataValue = null;
                }

                if (dataName)
                {
                    if (camMessage.message.message.key && camMessage.message.message.key.simpleItem)
                    {
                        objectId = camMessage.message.message.key.simpleItem.$.Value;
                    }

                    Homey.app.updateLog("\Event data: (" + this.name + ") " + eventTopic + ": " + dataName + " = " + dataValue + (objectId === "" ? "" : (" (" + objectId + ")")), 1, true);
                    const compareSetting = eventTopic + ':' + dataName;
                    if ((compareSetting === this.eventTN) && ((this.eventObjectID === "") || (this.eventObjectID.indexOf(objectId) >= 0)))
                    {
                        this.triggerMotionEvent(dataName, dataValue);
                    }
                    else if ((compareSetting === "RuleEngine/LineDetector/Crossed:ObjectId") && ((this.eventObjectID === "") || (this.eventObjectID.indexOf(dataValue) >= 0)))
                    {
                        // Line crossed
                        this.triggerLineCrossedEvent(dataValue);
                    }
                    else if (compareSetting === "VideoSource/ImageTooDark/ImagingService:State")
                    {
                        // Image too dark dataName = 'State', 'dataValue = true / false
                        this.triggerDarkImageEvent(dataValue);
                    }
                    else if (compareSetting === "Monitoring/ProcessorUsage:Value")
                    {
                        // Processor usage = 'Value', 'dataValue = %usage
                        this.setCapabilityValue( 'measure_cpu', dataValue).catch(this.error);
                    }
                    else if (compareSetting === "Device/HardwareFailure/StorageFailure:Failed")
                    {
                        // Processor usage = 'Value', 'dataValue = %usage
                        this.setCapabilityValue( 'alarm_storage', dataValue).catch(this.error);
                    }
                    else if (dataName === "IsTamper")
                    {
                        this.triggerTamperEvent(dataName, dataValue);
                    }
                    else
                    {
                        Homey.app.updateLog("Ignoring event type (" + this.name + ") " + eventTopic + ": " + dataName + " = " + dataValue);
                    }
                }
            }
            catch (err)
            {
                Homey.app.updateLog("Camera Event Error (" + this.name + "): " + err.stack, 0);
            }
        }
    }

    async onCapabilityMotionEnable(value, opts)
    {
        if (this.enabled)
        {
            try
            {
                clearTimeout(this.eventSubscriptionRenewTimerId);
                clearTimeout(this.eventTimerId);

                console.log("onCapabilityMotionEnable: ", value);
                this.setCapabilityValue('alarm_motion', false).catch(this.error);

                if (value && this.hasMotion)
                {
                    Homey.app.updateLog("Switch motion detection On (" + this.name + ")");

                    // Start listening for motion events
                    setImmediate(() =>
                    {
                        this.listenForEvents(this.cam);
                        return;
                    });

                    this.motionEnabledTrigger
                        .trigger(this)
                        .catch(this.error)
                        .then(this.log("Triggered enable on"));
                }
                else
                {
                    try
                    {
                        Homey.app.updateLog("Switch motion detection Off (" + this.name + ")");

                        // Switch off the current even mode
                        await Homey.app.unsubscribe(this);

                    }
                    catch (err)
                    {
                        Homey.app.updateLog(this.getName() + " onCapabilityOff Error (" + this.name + ") " + err.stack, 0);
                        throw (err);
                    }

                    this.motionDisabledTrigger
                        .trigger(this)
                        .catch(this.error)
                        .then(this.log("Triggered enable off"));
                }

            }
            catch (err)
            {
                //this.setUnavailable();
                Homey.app.updateLog(this.getName() + " onCapabilityOnoff Error (" + this.name + ") " + err.stack, 0);
                throw (err);
            }
        }
    }

    async setupImages()
    {
        if (!this.snapshotSupported && !this.userSnapUri)
        {
            return;
        }

        try
        {
            const devData = this.getData();

            this.invalidAfterConnect = false;

            if (!this.userSnapUri)
            {
                // Use ONVIF snapshot URL
                const snapURL = await Homey.app.getSnapshotURL(this.cam);
                if (snapURL.uri.indexOf("http") < 0)
                {
                    this.snapUri = null;
                    Homey.app.updateLog("Invalid Snapshot URL, it must be http or https: " + Homey.app.varToString(snapURL.uri).replace(this.password, "YOUR_PASSWORD"), 0);
                    return;
                }

                this.snapUri = snapURL.uri;
                this.invalidAfterConnect = snapURL.invalidAfterConnect;

            }
            else
            {
                this.snapUri = this.userSnapUri;
            }

            if (this.channel >= 0)
            {
                // Check if the uri has a channel number and replace it with the settings
                let chanelPos = this.snapUri.indexOf("channel=");
                if (chanelPos > 0)
                {
                    let tempStr = this.snapUri.substr(0, chanelPos + 8) + this.channel + this.snapUri.substr(chanelPos + 9);
                    this.snapUri = tempStr;
                }
            }

            const publicSnapURL = this.snapUri.replace(this.password, "YOUR_PASSWORD");
            await this.setSettings(
            {
                "url": publicSnapURL
            });

            Homey.app.updateLog("Snapshot URL: " + Homey.app.varToString(this.snapUri).replace(this.password, "YOUR_PASSWORD"));

            if (!this.nowImage)
            {
                this.nowImage = new Homey.Image();
                this.nowImage.setStream(async (stream) =>
                {
                    if (this.invalidAfterConnect)
                    {
                        await Homey.app.getSnapshotURL(this.cam);
                    }

                    var res = await this.doFetch("NOW");
                    if (!res.ok)
                    {
                        Homey.app.updateLog("Fetch NOW error (" + this.name + "): " + res.statusText, 0);
                        console.log(res);
                        console.log(res.headers.raw());
                        throw new Error(res.statusText);
                    }

                    res.body.pipe(stream);

                    stream.on('error', (err) =>
                    {
                        Homey.app.updateLog("Fetch Now image error (" + this.name + "): " + err.stack, 0);
                    });
                    stream.on('finish', () =>
                    {
                        Homey.app.updateLog("Now Image Updated (" + this.name + ")");
                    });
                });

                Homey.app.updateLog("Registering Now image (" + this.name + ")");
                this.nowImage.register()
                    .then(() =>
                    {
                        Homey.app.updateLog("registered Now image (" + this.name + ")");
                        this.setCameraImage('Now', Homey.__("Now"), this.nowImage);
                    })
                    .catch((err) =>
                    {
                        Homey.app.updateLog("Register Now image error (" + this.name + "): " + err.stack, 0);
                    });
            }

            try
            {
                const imageFilename = 'eventImage' + devData.id;
                this.eventImageFilename = imageFilename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
                this.eventImageFilename += ".jpg";
                Homey.app.updateLog("SnapShot save file (" + this.name + ") = " + this.eventImageFilename);

                const eventImagePath = Homey.app.getUserDataPath(this.eventImageFilename);
                if (!fs.existsSync(eventImagePath))
                {
                    this.updatingEventImage = true;

                    Homey.app.updateLog("Initialising event image (" + this.name + ")");
                    // Initialise the event image with the current snapshot
                    const storageStream = fs.createWriteStream(eventImagePath);
                    Homey.app.updateLog("Fetching event image (" + this.name + ")");

                    if (this.invalidAfterConnect)
                    {
                        // Suggestions on the internet say this has to be called before getting the snapshot if invalidAfterConnect = true
                        await Homey.app.getSnapshotURL(this.cam);
                    }

                    var res = await this.doFetch("Motion Event");
                    if (!res.ok)
                    {
                        Homey.app.updateLog("Fetch MOTION error (" + this.name + "): " + Homey.app.varToString(res), 0);
                        this.updatingEventImage = false;
                        throw new Error(res.statusText);
                    }

                    res.body.pipe(storageStream);

                    storageStream.on('error', (err) =>
                    {
                        Homey.app.updateLog("Fetch event image error (" + this.name + "): " + err.stack, true);
                        this.updatingEventImage = false;
                    });
                    storageStream.on('finish', () =>
                    {
                        Homey.app.updateLog("Event Image Updated (" + this.name + ")");
                        this.updatingEventImage = false;
                    });

                    // Allow time for the image to download before setting up the view image
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }

                // Register the event image, even if motion is not supported, so it can be initiated by the flow action
                if (!this.eventImage)
                {
                    Homey.app.updateLog("Registering event image (" + this.name + ")");
                    this.eventImage = new Homey.Image();
                    this.eventImage.setPath(eventImagePath);
                    this.eventImage.register()
                        .then(() =>
                        {
                            Homey.app.updateLog("registered event image (" + this.name + ")");
                            this.setCameraImage('Event', Homey.__("Motion_Event"), this.eventImage);
                        })
                        .catch((err) =>
                        {
                            Homey.app.updateLog("Register event image error (" + this.name + "): " + err.stack, 0);
                        });
                }
            }
            catch (err)
            {
                Homey.app.updateLog("Event SnapShot error (" + this.name + "): " + err.stack, 0);
                this.updatingEventImage = false;
            }
        }
        catch (err)
        {
            //Homey.app.updateLog("SnapShot error: " + Homey.app.varToString(err), true);
            Homey.app.updateLog("SnapShot error (" + this.name + "): " + err.stack, 0);
        }
    }

    async doFetch(name)
    {
        var res = {};
        try
        {
            if (this.authType == 0)
            {
                Homey.app.updateLog("Fetching (" + this.name + ") " + name + " image from: " + Homey.app.varToString(this.snapUri).replace(this.password, "YOUR_PASSWORD"));
                res = await fetch(this.snapUri);
                if (res.status == 401)
                {
                    // Try Basic Authentication
                    this.authType = 1;
                }
            }
        }
        catch (err)
        {
            Homey.app.updateLog("SnapShot error (" + this.name + "): " + err.stack, 0);
            // Try Basic Authentication
            this.authType = 1;
        }

        try
        {
            if (this.authType == 1)
            {
                Homey.app.updateLog("Fetching (" + this.name + ") " + name + " image with Basic Auth. From: " + Homey.app.varToString(this.snapUri).replace(this.password, "YOUR_PASSWORD"));

                const client = new DigestFetch(this.username, this.password,
                {
                    basic: true
                });
                res = await client.fetch(this.snapUri);
                if (res.status == 401)
                {
                    // Try Digest Authentication
                    this.authType = 2;
                }
            }
        }
        catch (err)
        {
            Homey.app.updateLog("SnapShot error (" + this.name + "): " + err.stack, 0);
            // Try Digest Authentication
            this.authType = 2;
        }

        try
        {
            if (this.authType >= 2)
            {
                Homey.app.updateLog("Fetching (" + this.name + ") " + name + " image with Digest Auth. From: " + Homey.app.varToString(this.snapUri).replace(this.password, "YOUR_PASSWORD"));

                const client = new DigestFetch(this.username, this.password,
                {
                    algorithm: 'MD5'
                });
                res = await client.fetch(this.snapUri);
                if (res.status == 401)
                {
                    // Go back to no Authentication
                    this.authType = 0;
                }
            }
        }
        catch (err)
        {
            Homey.app.updateLog("SnapShot error (" + this.name + "): " + err.stack, 0);

            // Go back to no Authentication
            this.authType = 0;

            res = {
                'ok': false,
                'statusText': err.message
            };
        }

        return res;
    }

    async logout()
    {
        if (this.cam)
        {
            clearTimeout(this.checkTimerId);
            clearTimeout(this.eventSubscriptionRenewTimerId);
            clearTimeout(this.eventTimerId);
            if (this.cam)
            {
                //Stop listening for motion events
                this.cam.removeAllListeners('event');
                await Homey.app.unsubscribe(this);
            }
            this.cam = null;
        }
    }

    async onDeleted()
    {
        try
        {
            clearTimeout(this.checkTimerId);
            clearTimeout(this.eventSubscriptionRenewTimerId);
            clearTimeout(this.eventTimerId);
            if (this.cam)
            {
                //Stop listening for motion events
                this.cam.removeAllListeners('event');

                await Homey.app.unsubscribe(this);
            }

            if (this.eventImageFilename)
            {
                const eventImagePath = Homey.app.getUserDataPath(this.eventImageFilename);
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
            console.log("Delete device");
        }
        catch (err)
        {
            console.log("Delete device error", err);
        }
    }
}

module.exports = CameraDevice;