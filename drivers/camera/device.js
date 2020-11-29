'use strict';

const Homey = require('homey');
const DigestFetch = require('/lib/digest-fetch');
const fetch = require('node-fetch');
const fs = require('fs');
const
{
    isArray
} = require('util');

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

        // Upgrade old device settings where the ip and port where part of the data
        const settings = this.getSettings();
        const devData = this.getData();
        if (typeof settings.ip === "undefined")
        {
            await this.setSettings(
            {
                'ip': devData.id,
                'port': devData.port.toString()
            })
        }

        this.preferPullEvents = settings.preferPullEvents;
        this.hasMotion = settings.hasMotion;
        if (typeof settings.channel === "undefined")
        {
            await this.setSettings(
            {
                'channel': -1
            })
        }

        if (typeof settings.token === "undefined")
        {
            await this.setSettings(
            {
                'token': ""
            })
        }

        this.password = settings.password
        this.username = settings.username;
        this.ip = settings.ip;
        this.port = settings.port;
        this.channel = settings.channel;
        this.token = settings.token;
        this.userSnapUri = settings.userSnapUri;

        this.id = devData.id;
        Homey.app.updateLog("Initialising CameraDevice (" + this.id + ")");

        if (this.hasCapability('alarm_motion'))
        {
            this.setCapabilityValue('alarm_motion', false);
        }

        let requiredClass = settings.classType;
        if (this.getClass() != requiredClass)
        {
            this.setClass(requiredClass);
        }

        this.connectCamera(false)
            .catch(err =>
            {
                Homey.app.updateLog("Check Camera Error (" + this.id + "): " + Homey.app.varToString(err), 0);
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
            Homey.app.updateLog("Syncing time (" + this.id + ")");

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
                            Homey.app.updateLog("Check Camera Error (" + this.id + "): " + Homey.app.varToString(err), 0);
                        }
                    });
            }
            catch (err)
            {
                Homey.app.updateLog("Check Camera Error (" + this.id + "): " + Homey.app.varToString(err), 0);
            }
        });
    }

    async onAdded()
    {
        Homey.app.updateLog('CameraDevice has been added (' + this.id + ')');
        //Allow some time for the validation check cam connection to disconnect
        await new Promise(resolve => setTimeout(resolve, 2000));
        await this.getDriver().getLastCredentials(this);
        this.connectCamera(true)
            .catch(this.error);
    }

    async onSettings(oldSettingsObj, newSettingsObj, changedKeysArr)
    {
        let reconnect = false;

        //console.log("Settings: ", oldSettingsObj, newSettingsObj, changedKeysArr);
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

        if (reconnect)
        {
            // re-connect to camera after exiting this callback
            setImmediate(() =>
            {
                this.connectCamera(false);
                return;
            });
        }

        if (changedKeysArr.indexOf("timeFormat") >= 0)
        {
            this.setCapabilityValue('event_time', this.convertDate(this.eventTime, newSettingsObj));
            this.setCapabilityValue('tamper_time', this.convertDate(this.alarmTime, newSettingsObj));
            this.setCapabilityValue('date_time', this.convertDate(this.cameraTime, newSettingsObj));
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
    }

    async connectCamera(addingCamera)
    {
        if (this.repairing)
        {
            // Wait while repairing and try again later
            this.checkTimerId = setTimeout(this.connectCamera.bind(this, addingCamera), 2000);
        }
        else if (this.getStoreValue('initialised'))
        {
            let settings = this.getSettings();

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
                    Homey.app.updateLog("Global Camera event error (" + this.id + "): " + Homey.app.varToString(msg), 0);
                    if (xml)
                    {
                        Homey.app.updateLog("xml: " + Homey.app.varToString(xml), 2);
                    }
                });

                this.supportPushEvent = false;
                try
                {
                    let services = await Homey.app.getServices(this.cam);
                    if (Array.isArray(services))
                    {
                        services.forEach((service) =>
                        {
                            if (service.namespace.search('.org/') > 0){
                                let namespaceSplitted = service.namespace.split('.org/')[1].split('/');
                                if ((namespaceSplitted[1] == 'events') && service.capabilities && service.capabilities.capabilities)
                                {
                                    let serviceCapabilities = service.capabilities.capabilities['$'];
                                    if (serviceCapabilities['MaxNotificationProducers'] > 0)
                                    {
                                        this.supportPushEvent = true;
                                        Homey.app.updateLog("** PushEvent supported on " + this.id);
                                    }
                                }
                                if ((namespaceSplitted[1] == 'media') && service.capabilities && service.capabilities.capabilities)
                                {
                                    let serviceCapabilities = service.capabilities.capabilities['$'];
                                    if (serviceCapabilities['SnapshotUri'] >= 0)
                                    {
                                        this.snapshotSupported = serviceCapabilities['SnapshotUri'];
                                        if (this.snapshotSupported)
                                        {
                                            Homey.app.updateLog("** Snapshots are supported on " + this.id);
                                        }
                                        else
                                        {
                                            Homey.app.updateLog("** Snapshots NOT supported on " + this.id, this.snapshotSupported, 0);
                                        }
                                    }
                                }
                            }
                            else{
                                Homey.app.updateLog("getServices: Unrecognised namespace for service " + service);
                            }
                        });
                    }
                }
                catch (err)
                {
                    Homey.app.updateLog("Get camera services error (" + this.id + "): " + err.stack, 0);
                }

                //if (addingCamera) {
                let info = {};
                try
                {
                    info = await Homey.app.getDeviceInformation(this.cam);
                    Homey.app.updateLog("Camera Information (" + this.id + "): " + Homey.app.varToString(info, ));
                }
                catch (err)
                {
                    Homey.app.updateLog("Get camera info error (" + this.id + "): " + err.stack, 0);
                }

                let supportedEvents = [""];
                try
                {
                    let capabilities = await Homey.app.getCapabilities(this.cam);
                    this.hasPullPoints = Homey.app.hasPullSupport(capabilities, this.id);
                    if (this.hasPullPoints || this.supportPushEvent)
                    {
                        supportedEvents = await Homey.app.hasEventTopics(this.cam);
                    }
                }
                catch (err)
                {
                    Homey.app.updateLog("Get camera capabilities error (" + this.id + "): " + err.stack, 0);
                }
                Homey.app.updateLog("Supported Events(" + this.id + "): " + supportedEvents);

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
                })

                settings = this.getSettings();

                if (!this.hasMotion)
                {
                    Homey.app.updateLog("Removing unsupported motion capabilities for " + this.id);

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
                this.setCapabilityValue('alarm_tamper', false);
                Homey.app.updateLog("Camera (" + this.id + ") is ready");
            }
            catch (err)
            {
                if (!this.repairing)
                {
                    Homey.app.updateLog("Connect to camera error (" + this.id + "): " + err.stack, 0);
                    this.setUnavailable();
                }
                this.checkTimerId = setTimeout(this.connectCamera.bind(this, addingCamera), 5000);
                this.setCapabilityValue('alarm_tamper', false);
            }
        }
    }

    async checkCamera()
    {
        if (!this.repairing && this.isReady && Homey.ManagerSettings.get('logLevel') === '0')
        {
            try
            {
                let date = await Homey.app.getDateAndTime(this.cam);
                if (this.getCapabilityValue('alarm_tamper'))
                {
                    Homey.app.updateLog("Check Camera (" + this.id + "): back online");
                    this.setCapabilityValue('alarm_tamper', false);
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
                    this.setCapabilityValue('date_time', this.convertDate(this.cameraTime, this.getSettings()));

                    if (!this.snapUri)
                    {
                        await this.setupImages();
                    }
                }
            }
            catch (err)
            {
                err = String(err);
                Homey.app.updateLog("Check Camera Error (" + this.id + "): " + Homey.app.varToString(err), 0);

                if (!this.getCapabilityValue('alarm_tamper'))
                {
                    this.setCapabilityValue('alarm_tamper', true);
                    this.alarmTime = new Date(Date.now());
                    this.setStoreValue('alarmTime', this.alarmTime);
                    this.setCapabilityValue('tamper_time', this.convertDate(this.alarmTime, this.getSettings()));
                }

                if (err.indexOf("EHOSTUNREACH") >= 0)
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
        const storageStream = fs.createWriteStream(Homey.app.getUserDataPath(this.eventImageFilename));

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
            Homey.app.updateLog("Invalid Snapshot URL, it must be http or https: " + Homey.app.varToString(snapURL.uri).replace(this.password, "YOUR_PASSWORD"), 0);
            return;
        }
        Homey.app.updateLog("Event snapshot URL (" + this.id + "): " + Homey.app.varToString(this.snapUri).replace(this.password, "YOUR_PASSWORD"));

        var res = await this.doFetch("MOTION EVENT");
        if (!res.ok)
        {
            Homey.app.updateLog(Homey.app.varToString(res));
            throw new Error(res.statusText);
        }

        return new Promise((resolve, reject) =>
        {
            res.body.pipe(storageStream);
            storageStream.on('error', (err) =>
            {
                Homey.app.updateLog(Homey.app.varToString(err));
                return reject(err);
                //throw new Error(err);
            })
            storageStream.on('finish', () =>
            {
                this.eventImage.update();
                Homey.app.updateLog("Event Image Updated (" + this.id + ")");

                let tokens = {
                    'eventImage': this.eventImage
                }

                this.eventShotReadyTrigger
                    .trigger(this, tokens)
                    .catch(err =>
                    {
                        Homey.app.updateLog("Snapshot error (" + this.id + "): " + Homey.app.varToString(err), 0);
                        return reject(err);
                    })
                    .then(() =>
                    {
                        return resolve(true);
                    })
            });
        });
    }

    async updateMotionImage(delay)
    {
        if (!this.updatingEventImage)
        {
            this.updatingEventImage = true;

            // Safeguard against flag not being reset for some reason
            let timerId = setTimeout(() =>
            {
                this.updatingEventImage = false
            }, delay * 1000 + 20000);

            this.eventTime = new Date(Date.now());
            this.setStoreValue('eventTime', this.eventTime);
            const settings = this.getSettings();
            this.setCapabilityValue('event_time', this.convertDate(this.eventTime, settings));
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
                        Homey.app.updateLog("Event image error (" + this.id + "): " + err, 0);
                        clearTimeout(timerId);
                        timerId = setTimeout(() =>
                        {
                            this.updatingEventImage = false
                        }, 20000);
                    }
                }
            }
            this.updatingEventImage = false;
            return true;
        }
        else
        {
            Homey.app.updateLog("** Event STILL Processing last image (" + this.id + ") **", 0);
            return false;
        }
    }

    async triggerMotionEvent(dataName, dataValue)
    {
        const settings = this.getSettings();
        this.setAvailable();

        if (dataValue)
        {
            // Set a timer to clear the motion
            clearTimeout(this.eventTimeoutId);
            this.eventTimeoutId = setTimeout(() =>
            {
                this.setCapabilityValue('alarm_motion', false);
                console.log("Event off timeout");
            }, 180000);
        }
        if (this.getCapabilityValue('motion_enabled'))
        {
            if (!settings.single || dataValue != this.getCapabilityValue('alarm_motion'))
            {
                Homey.app.updateLog("Event Processing (" + this.id + "):" + dataName + " = " + dataValue);
                this.setCapabilityValue('alarm_motion', dataValue);
                if (dataValue)
                {
                    Homey.app.updateLog("Updating Motion Image in " + settings.delay + "seconds");
                    await this.updateMotionImage(settings.delay);
                }
                else
                {
                    clearTimeout(this.eventTimeoutId);
                }
            }
            else
            {
                Homey.app.updateLog("Ignoring unchanged event (" + this.id + ") " + dataName + " = " + dataValue);
            }
        }
    }

    async triggerTamperEvent(dataName, dataValue)
    {
        const settings = this.getSettings();
        this.setAvailable();

        if (dataValue != this.getCapabilityValue('alarm_tamper'))
        {
            Homey.app.updateLog("Event Processing (" + this.id + "):" + dataName + " = " + dataValue);
            this.setCapabilityValue('alarm_tamper', dataValue);
            if (dataValue)
            {
                this.alarmTime = new Date(Date.now());
                this.setStoreValue('alarmTime', this.alarmTime);
                this.setCapabilityValue('tamper_time', this.convertDate(this.alarmTime, this.getSettings()));
            }
        }
        else
        {
            Homey.app.updateLog("Ignoring unchanged event (" + this.id + ") " + dataName + " = " + dataValue);
        }
    }

    async listenForEvents(cam_obj)
    {
        //Stop listening for motion events before we add a new listener
        this.cam.removeAllListeners('event');

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
                Homey.app.updateLog('\r\n## Waiting for Push events (' + this.id + ') ##');

                Homey.app.subscribeToCamPushEvents(this);
                return;
            }

            Homey.app.updateLog('## Waiting for Pull events (' + this.id + ') ##');
            cam_obj.on('event', (camMessage, xml) =>
            {
                this.processCamEventMessage(camMessage);
            });
        }
    }

    async processCamEventMessage(camMessage)
    {
        if (this.getCapabilityValue('motion_enabled'))
        {
            try
            {
                Homey.app.updateLog('\r\n--  Event detected (' + this.id + ')  --');
                Homey.app.updateLog(Homey.app.varToString(camMessage));

                this.setAvailable();

                let eventTopic = camMessage.topic._
                eventTopic = Homey.app.stripNamespaces(eventTopic)

                let dataName = "";
                let dataValue = "";

                // DATA (Name:Value)
                if (camMessage.message.message.data && camMessage.message.message.data.simpleItem)
                {
                    if (Array.isArray(camMessage.message.message.data.simpleItem))
                    {
                        for (let x = 0; x < camMessage.message.message.data.simpleItem.length; x++)
                        {
                            dataName = camMessage.message.message.data.simpleItem[x].$.Name
                            dataValue = camMessage.message.message.data.simpleItem[x].$.Value
                        }
                    }
                    else
                    {
                        dataName = camMessage.message.message.data.simpleItem.$.Name
                        dataValue = camMessage.message.message.data.simpleItem.$.Value
                    }
                }
                else if (camMessage.message.message.data && camMessage.message.message.data.elementItem)
                {
                    Homey.app.updateLog("WARNING: Data contain an elementItem", 0)
                    dataName = 'elementItem'
                    dataValue = Homey.app.varToString(camMessage.message.message.data.elementItem)
                }
                else
                {
                    Homey.app.updateLog("WARNING: Data does not contain a simpleItem or elementItem", 0)
                    dataName = null
                    dataValue = null
                }

                if (dataName)
                {
                    Homey.app.updateLog("Event data: (" + this.id + ") " + eventTopic + ": " + dataName + " = " + dataValue);
                    if ((dataName === "IsMotion") || (dataName === "IsInside"))
                    {
                        this.triggerMotionEvent(dataName, dataValue);
                    }
                    else if (dataName === "IsTamper")
                    {
                        this.triggerTamperEvent(dataName, dataValue);
                    }
                    else
                    {
                        Homey.app.updateLog("Ignoring event type (" + this.id + ") " + eventTopic + ": " + dataName + " = " + dataValue);
                    }
                }
            }
            catch (err)
            {
                Homey.app.updateLog("Camera Event Error (" + this.id + "): " + err.stack, 0);
            }
        }
    }

    async onCapabilityMotionEnable(value, opts)
    {
        try
        {
            clearTimeout(this.eventSubscriptionRenewTimerId);
            clearTimeout(this.eventTimerId);

            console.log("onCapabilityMotionEnable: ", value);
            this.setCapabilityValue('alarm_motion', false);

            if (value && this.hasMotion)
            {
                Homey.app.updateLog("Switch motion detection On (" + this.id + ")");

                // Start listening for motion events
                setImmediate(() =>
                {
                    this.listenForEvents(this.cam);
                    return;
                });

                this.motionEnabledTrigger
                    .trigger(this)
                    .catch(this.error)
                    .then(this.log("Triggered enable on"))
            }
            else
            {
                try
                {
                    Homey.app.updateLog("Switch motion detection Off (" + this.id + ")");

                    // Switch off the current even mode
                    await Homey.app.unsubscribe(this);

                }
                catch (err)
                {
                    Homey.app.updateLog(this.getName() + " onCapabilityOff Error (" + this.id + ") " + err.stack, 0);
                }

                this.motionDisabledTrigger
                    .trigger(this)
                    .catch(this.error)
                    .then(this.log("Triggered enable off"))
            }

        }
        catch (err)
        {
            //this.setUnavailable();
            Homey.app.updateLog(this.getName() + " onCapabilityOnoff Error (" + this.id + ") " + err.stack, 0);
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
                let chanelPos = this.snapUri.indexOf("channel=")
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
            })

            Homey.app.updateLog("Snapshot URL: " + Homey.app.varToString(this.snapUri).replace(this.password, "YOUR_PASSWORD"));

            if (!this.nowImage)
            {
                this.nowImage = new Homey.Image();
                this.nowImage.setStream(async (stream) =>
                {
                    if (this.invalidAfterConnect)
                    {
                        await Homey.app.getSnapshotURL(this.cam)
                    }

                    var res = await this.doFetch("NOW");
                    if (!res.ok)
                    {
                        Homey.app.updateLog("Fetch NOW error (" + this.id + "): " + res.statusText, 0);
                        console.log(res);
                        console.log(res.headers.raw());
                        throw new Error(res.statusText);
                    }

                    res.body.pipe(stream);

                    stream.on('error', (err) =>
                    {
                        Homey.app.updateLog("Fetch Now image error (" + this.id + "): " + err.stack, 0);
                    })
                    stream.on('finish', () =>
                    {
                        Homey.app.updateLog("Now Image Updated (" + this.id + ")");
                    });
                });

                Homey.app.updateLog("Registering Now image (" + this.id + ")");
                this.nowImage.register()
                    .then(() =>
                    {
                        Homey.app.updateLog("registered Now image (" + this.id + ")")
                        this.setCameraImage('Now', Homey.__("Now"), this.nowImage);
                    })
                    .catch((err) =>
                    {
                        Homey.app.updateLog("Register Now image error (" + this.id + "): " + err.stack, 0);
                    });
            }

            try
            {
                const imageFilename = 'eventImage' + devData.id;
                this.eventImageFilename = imageFilename.replace(/[^a-z0-9]/gi, '_').toLowerCase();
                this.eventImageFilename += ".jpg";
                Homey.app.updateLog("SnapShot save file (" + this.id + ") = " + this.eventImageFilename);

                const eventImagePath = Homey.app.getUserDataPath(this.eventImageFilename);
                if (!fs.existsSync(eventImagePath))
                {
                    this.updatingEventImage = true;

                    Homey.app.updateLog("Initialising event image (" + this.id + ")");
                    // Initialise the event image with the current snapshot
                    const storageStream = fs.createWriteStream(eventImagePath);
                    Homey.app.updateLog("Fetching event image (" + this.id + ")");

                    if (this.invalidAfterConnect)
                    {
                        // Suggestions on the internet say this has to be called before getting the snapshot if invalidAfterConnect = true
                        await Homey.app.getSnapshotURL(this.cam)
                    }

                    var res = await this.doFetch("Motion Event");
                    if (!res.ok)
                    {
                        Homey.app.updateLog("Fetch MOTION error (" + this.id + "): " + Homey.app.varToString(res), 0);
                        this.updatingEventImage = false;
                        throw new Error(res.statusText);
                    }

                    res.body.pipe(storageStream);

                    storageStream.on('error', (err) =>
                    {
                        Homey.app.updateLog("Fetch event image error (" + this.id + "): " + err.stack, true);
                        this.updatingEventImage = false;
                    })
                    storageStream.on('finish', () =>
                    {
                        Homey.app.updateLog("Event Image Updated (" + this.id + ")");
                        this.updatingEventImage = false;
                    });

                    // Allow time for the image to download before setting up the view image
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }

                if (!this.eventImage)
                {
                    Homey.app.updateLog("Registering event image (" + this.id + ")");
                    this.eventImage = new Homey.Image();
                    this.eventImage.setPath(eventImagePath);
                    this.eventImage.register()
                        .then(() =>
                        {
                            Homey.app.updateLog("registered event image (" + this.id + ")")
                            this.setCameraImage('Event', Homey.__("Motion_Event"), this.eventImage);
                        })
                        .catch((err) =>
                        {
                            Homey.app.updateLog("Register event image error (" + this.id + "): " + err.stack, 0);
                        });
                }
            }
            catch (err)
            {
                Homey.app.updateLog("Event SnapShot error (" + this.id + "): " + err.stack, 0);
                this.updatingEventImage = false;
            }
        }
        catch (err)
        {
            //Homey.app.updateLog("SnapShot error: " + Homey.app.varToString(err), true);
            Homey.app.updateLog("SnapShot error (" + this.id + "): " + err.stack, 0);
        }
    }

    async doFetch(name)
    {
        var res = {};
        try
        {
            if (this.authType == 0)
            {
                Homey.app.updateLog("Fetching (" + this.id + ") " + name + " image from: " + Homey.app.varToString(this.snapUri).replace(this.password, "YOUR_PASSWORD"));
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
            Homey.app.updateLog("SnapShot error (" + this.id + "): " + err.stack, 0);
            // Try Basic Authentication
            this.authType = 1;
        }

        try
        {
            if (this.authType == 1)
            {
                Homey.app.updateLog("Fetching (" + this.id + ") " + name + " image with Basic Auth. From: " + Homey.app.varToString(this.snapUri).replace(this.password, "YOUR_PASSWORD"));

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
            Homey.app.updateLog("SnapShot error (" + this.id + "): " + err.stack, 0);
            // Try Digest Authentication
            this.authType = 2;
        }

        try
        {
            if (this.authType >= 2)
            {
                Homey.app.updateLog("Fetching (" + this.id + ") " + name + " image with Digest Auth. From: " + Homey.app.varToString(this.snapUri).replace(this.password, "YOUR_PASSWORD"));

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
            Homey.app.updateLog("SnapShot error (" + this.id + "): " + err.stack, 0);

            // Go back to no Authentication
            this.authType = 0;

            res = {
                'ok': false,
                'statusText': err.message
            };
        }

        return res;
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