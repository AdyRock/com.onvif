/* eslint-disable no-unused-vars */
/*jslint node: true */
'use strict';
console.log('[BOOT-0] entry file executing');
// eslint-disable-next-line no-undef
if (process.env.DEBUG === '1') {
	require('inspector').open(9225, '0.0.0.0', true);
    console.log('[BOOT-1] inspector connected');
}

const Homey = require('homey');
let onvif = require('./lib/onvif');
let Cam = require('./lib/onvif').Cam;
const parseSOAPString = require('./lib/onvif/lib/utils').parseSOAPString;
const linerase = require('./lib/onvif/lib/utils').linerase;
const path = require('path');
const nodemailer = require('./lib/nodemailer');

const http = require('http');
const { promisify } = require('util');

console.log('[BOOT] module loaded');
class MyApp extends Homey.App
{

    _getHostKeyFromDevice(Device) {
        // Prefer device.ip + device.port; fallback to cam.hostname + cam.port
        const ip = (Device && Device.ip) ? String(Device.ip) : (Device && Device.cam && Device.cam.hostname ? String(Device.cam.hostname) : '');
        const port =
            (Device && Device.port) ? String(Device.port) :
            (Device && Device.cam && Device.cam.port) ? String(Device.cam.port) : '';

        // If port is missing, still return ip
        if (ip && port) return `${ip}:${port}`;
        return ip || '';
    }

    _dedupePush(key, ttlMs) {
        // Simple TTL cache to drop duplicate push deliveries (e.g., double subscription)
        // key should be stable for identical POST bodies. ttlMs typically 2000-5000ms.
        if (!this._pushDedupe) this._pushDedupe = new Map();

        const now = Date.now();

        // Prune occasionally (cheap)
        if (this._pushDedupe.size > 2000) {
            for (const [k, ts] of this._pushDedupe.entries()) {
                if ((now - ts) > ttlMs) this._pushDedupe.delete(k);
            }
            // Hard cap if still too big
            if (this._pushDedupe.size > 2500) {
                // delete oldest-ish by iteration order
                let n = this._pushDedupe.size - 2000;
                for (const k of this._pushDedupe.keys()) {
                    this._pushDedupe.delete(k);
                    if (--n <= 0) break;
                }
            }
        } else {
            // small prune
            for (const [k, ts] of this._pushDedupe.entries()) {
                if ((now - ts) > ttlMs) this._pushDedupe.delete(k);
            }
        }

        const last = this._pushDedupe.get(key);
        if (last && (now - last) <= ttlMs) {
            return true; // duplicate
        }
        this._pushDedupe.set(key, now);
        return false;
    }

    async onInit()
    {

        this.log('MyApp is running...');

        this.pushServerPort = this.homey.settings.get('port');
        if (!this.pushServerPort)
        {
            this.pushServerPort = 9998;
            this.homey.settings.set('port', 9998);
        }

        this.discoveredDevices = [];
        this.discoveryInitialised = false;
        //this.homey.settings.set('diagLog', "");

        this.homeyId = await this.homey.cloud.getHomeyId();
        this.homeyHash = this.hashCode(this.homeyId).toString();

        this.homeyIP = await this.homey.cloud.getLocalAddress();
        this.homeyIP = (this.homeyIP.split(':'))[0];

        this.pushEvents = [];

        this.logLevel = this.homey.settings.get('logLevel');

        this.homey.settings.on('set', (setting) =>
        {
            if (setting === 'logLevel')
            {
                this.logLevel = this.homey.settings.get('logLevel');
            }
            if (setting == 'port')
            {
                this.pushServerPort = this.homey.settings.get('port');
                this.unregisterCameras();
                this.server.close();
                this.server.listen(this.pushServerPort);
            }
        });

        this.registerFlowCard().catch(this.error);

        this.server = null;
        try
        {
            await this.runsListener();
        }
        catch (err)
        {
            console.log('runsListener: ', err);
        }

        setImmediate(() =>
        {
            this.checkCameras();
        });

        this.homey.on('unload', () =>
        {
            if (this.server)
            {
                this.server.close();
                this.updateLog('Server closed', 0);
            }
            this.unregisterCameras();
        });

        this.homey.on('memwarn', (data) =>
        {
            if (data)
            {
                if (data.count >= data.limit - 2)
                {
                    this.homey.settings.set('diagLog', '');
                }
                this.updateLog(`memwarn! ${data.count} of ${data.limit}`, 0);
            }
            else
            {
                this.updateLog('memwarn', 0);
            }
        });

        this.homey.on('cpuwarn', (data) =>
        {
            if (data)
            {
                if (data.count >= data.limit - 2)
                {
                    this.updateLog('Closing server (cpu warning)', 0);
                    if (this.server && this.server.listening)
                    {
                        this.server.close((err) =>
                        {
                            this.updateLog(`Server closed: ${err}`, 0);
                        });
                        this.server.closeAllConnections();
                        setTimeout(() =>
                        {
                            this.server.close();
                            this.server.listen(this.pushServerPort);
                        }, 300000);
                    }
                }
                this.updateLog(`cpuwarn! ${data.count} of ${data.limit}`, 0);
            }
            else
            {
                this.updateLog('cpuwarn', 0);
            }
        });
    }

    async registerFlowCard()
    {
        this.motionCondition = this.homey.flow.getConditionCard('motionEnabledCondition');
        this.motionCondition.registerRunListener(async (args, state) =>
        {
            return await args.device.getCapabilityValue('motion_enabled'); // Promise<boolean>
        });

        this.motionReadyCondition = this.homey.flow.getConditionCard('motionReadyCondition');
        this.motionReadyCondition.registerRunListener(async (args, state) =>
        {
            let remainingTime = args.waitTime * 10;
            while ((remainingTime > 0) && args.device.updatingEventImage)
            {
                // Wait for image to update
                await this.homey.app.asyncDelay(100);
                remainingTime--;
            }
            return !args.device.updatingEventImage;
        });

        this.motionEnabledAction = this.homey.flow.getActionCard('motionEnableAction');
        this.motionEnabledAction.registerRunListener(async (args, state) =>
        {
            console.log('motionEnabledAction');
            args.device.onCapabilityMotionEnable(true, null);
            return await args.device.setCapabilityValue('motion_enabled', true); // Promise<void>
        });

        this.motionDisabledAction = this.homey.flow.getActionCard('motionDisableAction');
        this.motionDisabledAction.registerRunListener(async (args, state) =>
        {

            console.log('motionDisabledAction');
            args.device.onCapabilityMotionEnable(false, null);
            return await args.device.setCapabilityValue('motion_enabled', false); // Promise<void>
        });

        this.snapshotAction = this.homey.flow.getActionCard('snapshotAction');
        this.snapshotAction.registerRunListener(async (args, state) =>
        {

            let err = await args.device.nowImage.update();
            if (!err)
            {
                let tokens = {
                    'image': args.device.nowImage
                };

                args.device.driver.snapshotReadyTrigger
                    .trigger(args.device, tokens)
                    .catch(args.device.error)
                    .then(args.device.log('Now Snapshot ready (' + args.device.id + ')'));
            }
            return err;
        });

        this.motionUpdateAction = this.homey.flow.getActionCard('updateMotionImageAction');
        this.motionUpdateAction.registerRunListener(async (args, state) =>
        {
            return args.device.updateMotionImage(0);
        });

		// Add action trigger for presets
		this.gotoPresetAction = this.homey.flow.getActionCard('goto_preset')
			.registerRunListener(async (args, state) =>
			{
				const device = args.device;
				const presetNumber = args.preset;
				return device.gotoPresetNumber(presetNumber);
			});

        this.motionTrigger = this.homey.flow.getTriggerCard('global_motion_detected');

    }

    hashCode(s)
    {
        for (var i = 0, h = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
        return h;
    }

    getMessageToken(message)
    {
        if (message.source && message.source.simpleItem)
        {
            let simpleItem;
            if (Array.isArray(message.source.simpleItem))
            {
                simpleItem = message.source.simpleItem[0];
            }
            else
            {
                simpleItem = message.source.simpleItem;
            }

            if (simpleItem && simpleItem.$)
            {
                return simpleItem.$.Value;
            }
        }

        return null;
    }

    async processEventMessage(soapMsg, eventHostKey){
        parseSOAPString(soapMsg, (err, res, xml) =>
        {
            if (!err && res)
            {
                let data = linerase(res).notify;

                if (data && data.notificationMessage)
                {
                    if (!Array.isArray(data.notificationMessage))
                    {
                        data.notificationMessage = [data.notificationMessage];
                    }

                    let messageToken = this.getMessageToken(data.notificationMessage[0].message.message);
                    this.updateLog(`Push event token: ${messageToken}`, 1);

                    // Find the referenced device
                    const driver = this.homey.drivers.getDriver('camera');
                    let theDevice = null;

                    if (driver)
                    {
                        let devices = driver.getDevices();
                        for (let i = 0; i < devices.length; i++)
                        {
                            let device = devices[i];

                            // Build hostKey for this device: ip:port
                            const dIp = device && device.ip ? String(device.ip) : '';
                            const dPort = device && device.port ? String(device.port) : '';
                            const deviceHostKey = (dIp && dPort) ? `${dIp}:${dPort}` : dIp;

                            if (deviceHostKey === eventHostKey)
                            {
                                // Correct IP:PORT so check token (multi-channel)
                                if (!device.token || !messageToken || (messageToken == device.token))
                                {
                                    theDevice = device;
                                    if (this.logLevel >= 2)
                                    {
                                        this.updateLog('Push Event found correct Device: ' + device.token);
                                    }
                                    break;
                                }
                                else
                                {
                                    if (this.logLevel >= 2)
                                    {
                                        this.updateLog('Wrong channel token');
                                    }
                                }
                            }
                        }
                    }

                    if (theDevice)
                    {
                        data.notificationMessage.forEach((message) =>
                        {
                            if (this.logLevel >= 2)
                            {
                                this.updateLog('Push Event process: ' + this.varToString(message));
                            }
                            theDevice.processCamEventMessage(message);
                        });
                    }
                    else
                    {
                        this.updateLog('Push Event unknown Device: ' + eventHostKey, 0);
                    }
                }
            }
            else
            {
                this.updateLog('Push data error: ' + err, 0);
            }
        });
    }


    async runsListener(){
        const requestListener = (request, response) =>
        {
            let pathParts = request.url.split('/');

            if ((pathParts[1] === 'onvif') && (pathParts[2] === 'events') && request.method === 'POST')
            {
                const rawHostKey = pathParts[3] || '';
                let eventHostKey = '';
                try {
                    eventHostKey = decodeURIComponent(rawHostKey);
                } catch (e) {
                    eventHostKey = rawHostKey;
                }

                const ctype = request.headers['content-type'] || '';
                if (ctype.startsWith('application/soap+xml'))
                {
                    let body = '';
                    request.on('data', chunk =>
                    {
                        body += chunk.toString();
                        if (body.length > 50000)
                        {
                            this.updateLog('Push data error: Payload too large', 0);
                            response.writeHead(413);
                            response.end('Payload Too Large');
                            body = '';
                            return;
                        }
                    });

                    request.on('end', () =>
                    {
                        const soapMsg = body;
                        body = '';

                        // Always ACK quickly
                        response.writeHead(200);
                        response.end('ok');

                        // DEDUPE: identical push deliveries within TTL (e.g., double subscription)
                        // Use a stable key: hostKey + payload length + first/last slice
                        // (No crypto dependency; cheap and good enough for duplicates.)
                        const head = soapMsg.slice(0, 400);
                        const tail = soapMsg.slice(-400);
                        const dedupeKey = `${eventHostKey}|${soapMsg.length}|${head}|${tail}`;

                        if (this._dedupePush(dedupeKey, 4000)) {
                            // Duplicate delivery detected; drop it quietly (or log at debug)
                            this.updateLog(`Push event deduped: ${eventHostKey}`, 2);
                            return;
                        }

                        if (this.logLevel >= 3)
                        {
                            this.updateLog('Push event: ' + soapMsg, 3);
                        }
                        else
                        {
                            this.updateLog(`Push event: ${eventHostKey}`, 2);
                        }

                        this.processEventMessage(soapMsg, eventHostKey);
                    });
                }
                else
                {
                    this.updateLog('Push data invalid content type: ' + ctype, 0);
                    response.writeHead(415);
                    response.end('Unsupported Media Type');
                }
            }
            else
            {
                this.updateLog('Push data error: ' + request.url + ': METHOD = ' + request.method, 0);
                response.writeHead(405);
                response.end('Method not allowed');
            }
        };

        this.server = http.createServer(requestListener);
        this.server.on('error', (e) =>
        {
            if (e.code === 'EADDRINUSE')
            {
                this.updateLog(`Server port ${this.pushServerPort} in use, retrying in 10 seconds`, 0);
                setTimeout(() =>
                {
                    this.server.close();
                    this.server.listen(this.pushServerPort);
                }, 10000);
            }
        });

        try
        {
            this.server.listen(this.pushServerPort);
        }
        catch (err)
        {
            this.log(err);
        }
    }

    async discoverCameras()
    {
        this.discoveredDevices = [];
        this.updateLog('====  Discovery Starting  ====');
        if (!this.discoveryInitialised)
        {
            this.discoveryInitialised = true;
            onvif.Discovery.on('device', async (cam, rinfo, xml) =>
            {
                try
                {
                    // function will be called as soon as NVT responds
                    this.updateLog('Reply from ' + this.varToString(cam), 1);

                    if (cam.href && cam.href.indexOf('onvif') >= 0)
                    {
                        let mac = null;
                        try
                        {
                            mac = await this.homey.arp.getMAC(cam.hostname);
                        }
                        catch (err)
                        {
                            this.log('Failed to get mac address', err);
                            mac = cam.urn;
                        }

                        this.discoveredDevices.push(
                            {
                                'name': cam.hostname,
                                data:
                                {
                                    'id': cam.urn ? cam.urn : mac
                                },
                                settings:
                                {
                                    // Store username & password in settings
                                    // so the user can change them later
                                    'username': '',
                                    'password': '',
                                    'ip': cam.hostname,
                                    'port': cam.port ? cam.port.toString() : '',
                                    'urn': cam.urn ? cam.urn : mac,
                                    'channel': -1,
                                }
                            });
                    }
                    else
                    {
                        this.updateLog('Discovery (' + cam.hostname + '): Invalid service URI', 0);
                    }
                }
                catch (err)
                {
                    this.updateLog('Discovery catch error: ' + err.message + '\n' + err.message, 0);
                }
            });

            onvif.Discovery.on('error', (msg, xml) =>
            {
                this.updateLog('Discovery on error: ' + this.varToString(msg), 0);
                if (xml)
                {
                    this.updateLog('xml: ' + this.varToString(xml), 3);
                }
            });
        }

        // Start the discovery process running
        onvif.Discovery.probe(
            {
                'resolve': false
            });

        // Allow time for the process to finish
        await new Promise(resolve => this.homey.setTimeout(resolve, 9000));

        // Add in a manual option

        this.updateLog('====  Discovery Finished  ====');
        let devices = this.discoveredDevices;

        this.discoveredDevices = [];
        return devices;
    }

    async connectCamera(hostname, port, username, password)
    {
        this.updateLog('--------------------------');
        this.updateLog('Connect to Camera ' + hostname + ':' + port + ' - ' + username);

        const camObj = new Cam(
            {
                homeyApp: this.homey,
                hostname: hostname,
                username: username,
                password: password,
                port: parseInt(port),
                timeout: 15000,
                autoconnect: false,
            });

        // Use Promisify that was added to Node v8

        const promiseGetSystemDateAndTime = promisify(camObj.getSystemDateAndTime).bind(camObj);
        const promiseGetServices = promisify(camObj.getServices).bind(camObj);
        const promiseGetCapabilities = promisify(camObj.getCapabilities).bind(camObj);
        const promiseGetDeviceInformation = promisify(camObj.getDeviceInformation).bind(camObj);
        const promiseGetProfiles = promisify(camObj.getProfiles).bind(camObj);
        const promiseGetVideoSources = promisify(camObj.getVideoSources).bind(camObj);

        // Use Promisify to convert ONVIF Library calls into Promises.
        // Date & Time must work before anything else
        await promiseGetSystemDateAndTime();

        // Services can live without
        let gotServices = null;
        try
        {
            gotServices = await promiseGetServices();
        }
        catch (err)
        {
            this.updateLog('Error getting services: ' + err.message, 0);
        }

        // Must have capabilities
        let gotCapabilities = await promiseGetCapabilities();

        // Must have device information
        let gotInfo = await promiseGetDeviceInformation();

        // Profiles are optional
        let gotProfiles = [];
        let gotActiveSources = [];
        try
        {
            gotProfiles = await promiseGetProfiles();
        }
        catch (err)
        {
            this.updateLog('Error getting profiles: ' + err.message, 0);
        }

        // Video sources are optional
        try
        {
            await promiseGetVideoSources();
            gotActiveSources = camObj.getActiveSources();
        }
        catch (err)
        {
            this.updateLog('Error getting video sources: ' + err.message, 0);
        }

        return (camObj);
    }

    async checkCameras()
    {
        do
        {
            await new Promise(resolve => this.homey.setTimeout(resolve, 10000));

            const driver = this.homey.drivers.getDriver('camera');
            if (driver)
            {
                let devices = driver.getDevices();
                for (let i = 0; i < devices.length; i++)
                {
                    let device = devices[i];
                    try
                    {
                        await device.checkCamera();
                    }
                    catch (err)
                    {
                        this.updateLog('checkCameras' + err.message, 0);
                    }
                }
            }
        }
        // eslint-disable-next-line no-constant-condition
        while (true);
    }

    async unregisterCameras()
    {
        const driver = this.homey.drivers.getDriver('camera');
        if (driver)
        {
            let devices = driver.getDevices();
            for (let i = 0; i < devices.length; i++)
            {
                let device = devices[i];
                try
                {
                    await device.logout();
                }
                catch (err)
                {
                    this.updateLog('unregisterCameras' + err.message, 0);
                }
            }
        }
    }

    async getHostName(camObj)
    {
        const promiseGetHostname = promisify(camObj.getHostname).bind(camObj);
        return promiseGetHostname();
    }

    async getDateAndTime(camObj)
    {
        const promiseGetSystemDateAndTime = promisify(camObj.getSystemDateAndTime).bind(camObj);
        return promiseGetSystemDateAndTime();
    }

    async getDeviceInformation(camObj)
    {
        const promiseGetDeviceInformation = promisify(camObj.getDeviceInformation).bind(camObj);
        return promiseGetDeviceInformation();
    }

    async getCapabilities(camObj)
    {
        const promiseGetCapabilities = promisify(camObj.getCapabilities).bind(camObj);
        return promiseGetCapabilities();
    }

    async getServices(camObj)
    {
        const promiseGetServices = promisify(camObj.getServices).bind(camObj);
        return promiseGetServices();
    }

    async getServiceCapabilities(camObj)
    {
        const promiseGetServiceCapabilities = promisify(camObj.getServiceCapabilities).bind(camObj);
        return promiseGetServiceCapabilities();
    }

    async getSnapshotURL(camObj)
    {
        const promiseGetSnapshotUri = promisify(camObj.getSnapshotUri).bind(camObj);
        return promiseGetSnapshotUri();
    }

    async getStreamURL(camObj, profileToken)
    {
        const promiseGetStreamUri = promisify(camObj.getStreamUri).bind(camObj);
        const promiseGetProfiles  = promisify(camObj.getProfiles).bind(camObj);

        let token = profileToken;

        // 1) Als geen token meegegeven: probeer profiles op te halen
        if (!token)
        {
            try
            {
                const profiles = await promiseGetProfiles();
                // Shape varieert per lib/camera; probeer meerdere vormen
                const p0 = Array.isArray(profiles) ? profiles[0] : profiles?.profiles?.[0] ?? profiles?.[0];
                token = p0?.$.token || p0?.token || p0?.profileToken || p0?.$?.profileToken;

                this.updateLog(`getStreamURL: selected profileToken=${token || '(none)'}`, 1);
            }
            catch (err)
            {
                // Log echte err details i.p.v. "undefined"
                this.updateLog(`getStreamURL: getProfiles failed: ${this.varToString(err)}`, 0);
            }
        }

        // 2) Alleen callen als we een token hebben
        if (!token)
        {
            throw new Error('No ONVIF profileToken available (getProfiles failed). Cannot request RTSP stream.');
        }

        // 3) Vraag RTSP streamUri op met expliciet profileToken
        return promiseGetStreamUri({
            profileToken: token,
            protocol: 'RTSP',
        });
    }


    async hasEventTopics(camObj)
    {
        const promiseGetSnapshotUri = promisify(camObj.getEventProperties).bind(camObj);
        const data = await promiseGetSnapshotUri();
        let supportedEvents = [];
        // Display the available Topics
        let parseNode = (node, topicPath, nodeName) =>
        {
            // loop over all the child nodes in this node
            for (const child in node)
            {
                if (child == '$')
                {
                    continue;
                }
                else if (child == 'messageDescription')
                {
                    // we have found the details that go with an event
                    supportedEvents.push(nodeName.toUpperCase());
                    return;
                }
                else
                {
                    // descend into the child node, looking for the messageDescription
                    parseNode(node[child], topicPath + '/' + child, child);
                }
            }
        };
        parseNode(data.topicSet, '', '');
        return (supportedEvents);
    }

    async subscribeToCamPushEvents(Device)
    {
        return new Promise((resolve, reject) =>
        {
            this.updateLog('App.subscribeToCamPushEvents: ' + Device.name);

            const hostKey = this._getHostKeyFromDevice(Device);     // "ip:port"
            const settingsKey = 'pushSubRef:' + hostKey;

            if (!hostKey) {
                const err = new Error('subscribeToCamPushEvents: Missing hostKey (ip/port)');
                this.updateLog(err.message, 0);
                reject(err);
                return;
            }

            // Find or create pushEvent bucket per hostKey (not per devices[0] heuristics)
            let pushEvent = this.pushEvents.find(pe => pe && pe.hostKey === hostKey);
            if (pushEvent)
            {
                this.updateLog('App.subscribeToCamPushEvents: Found entry for ' + hostKey);
                this.homey.clearTimeout(pushEvent.eventSubscriptionRenewTimerId);

                // Ensure device is registered in that bucket
                if (!pushEvent.devices.find(d => d.id == Device.id))
                {
                    this.updateLog('App.subscribeToCamPushEvents: Adding device ' + Device.name + ' to the queue');
                    pushEvent.devices.push(Device);
                }
            }
            else
            {
                this.updateLog('App.subscribeToCamPushEvents: Registering ' + hostKey);
                pushEvent = {
                    hostKey: hostKey,
                    devices: [Device],
                    refreshTime: 0,
                    unsubscribeRef: null,
                    eventSubscriptionRenewTimerId: null
                };
                this.pushEvents.push(pushEvent);
            }

            // Pull current in-memory ref; if missing, load persisted ref (survives app restart)
            let unsubscribeRef = pushEvent.unsubscribeRef;
            if (!unsubscribeRef)
            {
                const persisted = this.homey.settings.get(settingsKey);
                if (persisted)
                {
                    unsubscribeRef = persisted;
                    pushEvent.unsubscribeRef = persisted;
                    this.updateLog('App.subscribeToCamPushEvents: Loaded persisted subscription ref for ' + hostKey, 1);
                }
            }

            const scheduleRenew = (ref, refreshTimeMs) =>
            {
                // clamp and schedule
                let rt = refreshTimeMs - 5000;
                if (rt < 0)
                {
                    this.unsubscribe(Device).catch(this.err);
                    rt = 3000;
                }
                if (rt < 3000) rt = 3000;

                pushEvent.refreshTime = rt;
                pushEvent.unsubscribeRef = ref;

                // Persist so app restart can renew instead of creating a 2nd subscription
                this.homey.settings.set(settingsKey, ref);

                pushEvent.eventSubscriptionRenewTimerId = this.homey.setTimeout(() =>
                {
                    this.updateLog('Renewing subscription');
                    this.subscribeToCamPushEvents(Device).catch(this.err);
                }, rt);
            };

            if (unsubscribeRef)
            {
                // Try renew existing subscription
                this.updateLog('Renew previous events: ' + unsubscribeRef);

                Device.cam.RenewPushEventSubscription(unsubscribeRef, (err, info, xml) =>
                {
                    if (err)
                    {
                        this.updateLog('Renew subscription err (' + Device.name + '): ' + this.varToString(err), 0);

                        // Best effort: if renew fails, try to unsubscribe the old ref (may or may not work)
                        try {
                            Device.cam.UnsubscribePushEventSubscription(unsubscribeRef, (e2) => {
                                if (e2) this.updateLog('Best-effort unsubscribe after renew fail: ' + this.varToString(e2), 1);
                            });
                        } catch (e3) {
                            // ignore
                        }

                        // Reset ref and resubscribe (new subscription)
                        pushEvent.unsubscribeRef = null;
                        this.homey.settings.set(settingsKey, null);

                        setImmediate(() =>
                        {
                            this.updateLog('Resubscribing');
                            this.subscribeToCamPushEvents(Device).catch(this.err);
                        });

                        resolve(true);
                        return;
                    }
                    else
                    {
                        this.updateLog('Renew subscription response (' + Device.name + '): ' + Device.cam.hostname + '\r\ninfo: ' + this.varToString(info));

                        // Compute refresh time from response
                        let startTime = info[0].renewResponse[0].currentTime[0];
                        let endTime = info[0].renewResponse[0].terminationTime[0];
                        let d1 = new Date(startTime);
                        let d2 = new Date(endTime);
                        let refreshTime = (d2.valueOf() - d1.valueOf());

                        this.updateLog('Push renew every (' + Device.name + '): ' + (refreshTime / 1000), 1);

                        scheduleRenew(unsubscribeRef, refreshTime);
                        resolve(true);
                        return;
                    }
                });

                return;
            }

            // No ref known => create a new subscription (but stored persistently afterwards)
            const hostPath = encodeURIComponent(hostKey); // safe in URL path
            const url = 'http://' + this.homeyIP + ':' + this.pushServerPort + '/onvif/events/' + hostPath;

            this.updateLog('Setting up Push events (' + Device.name + ') on: ' + url);

            Device.cam.SubscribeToPushEvents(url, (err, info, xml) =>
            {
                if (err)
                {
                    this.updateLog('Subscribe err (' + Device.name + '): ' + err, 0);
                    reject(err);
                    return;
                }
                else
                {
                    this.updateLog('Subscribe response (' + Device.name + '): ' + Device.cam.hostname + ' - Info: ' + this.varToString(info));

                    unsubscribeRef = info[0].subscribeResponse[0].subscriptionReference[0].address[0];

                    let startTime = info[0].subscribeResponse[0].currentTime[0];
                    let endTime = info[0].subscribeResponse[0].terminationTime[0];
                    let d1 = new Date(startTime);
                    let d2 = new Date(endTime);
                    let refreshTime = (d2.valueOf() - d1.valueOf());

                    this.updateLog('Push renew every (' + Device.name + '): ' + (refreshTime / 1000) + 's  @ ' + unsubscribeRef, 1);

                    scheduleRenew(unsubscribeRef, refreshTime);

                    resolve(true);
                    return;
                }
            });
        });
    }


    async unsubscribe(Device)
    {
        return new Promise((resolve, reject) =>
        {
            if (!Device || !Device.cam || !this.pushEvents)
            {
                resolve(null);
                return;
            }

            const hostKey = this._getHostKeyFromDevice(Device);
            const settingsKey = 'pushSubRef:' + hostKey;

            this.updateLog('App.unsubscribe: ' + Device.name);

            let pushEventIdx = this.pushEvents.findIndex(pe => pe && pe.hostKey === hostKey);
            if (pushEventIdx < 0)
            {
                this.updateLog('App.unsubscribe: No Push entry for hostKey: ' + hostKey);
                Device.cam.removeAllListeners('event');
                resolve(null);
                return;
            }

            const pushEvent = this.pushEvents[pushEventIdx];
            if (!pushEvent || !pushEvent.devices)
            {
                resolve(null);
                return;
            }

            // Find device in bucket
            const deviceIdx = pushEvent.devices.findIndex(d => d && d.id == Device.id);
            if (deviceIdx < 0)
            {
                this.updateLog('App.unsubscribe: No Push entry for device in hostKey: ' + hostKey);
                resolve(null);
                return;
            }

            // Remove this device reference
            this.updateLog('App.unsubscribe: Unregister entry for ' + hostKey);
            pushEvent.devices.splice(deviceIdx, 1);

            // If no devices left, unsubscribe at camera and clear persisted ref
            const ref = pushEvent.unsubscribeRef || this.homey.settings.get(settingsKey);

            if ((pushEvent.devices.length === 0) && ref)
            {
                this.homey.clearTimeout(pushEvent.eventSubscriptionRenewTimerId);
                pushEvent.eventSubscriptionRenewTimerId = null;

                this.updateLog('Unsubscribe push event (' + hostKey + '): ' + ref, 1);

                Device.cam.UnsubscribePushEventSubscription(ref, (err, info, xml) =>
                {
                    if (err)
                    {
                        this.updateLog('Push unsubscribe error (' + hostKey + '): ' + this.varToString(err.message || err), 0);
                        // Even if unsubscribe fails, clear local state to avoid reusing a bad ref
                        try { this.homey.settings.set(settingsKey, null); } catch (e) { /* ignore */ }
                        // Remove bucket anyway to avoid stale entries
                        this.pushEvents.splice(pushEventIdx, 1);

                        Device.cam.removeAllListeners('event');
                        reject(err);
                        return;
                    }
                    else
                    {
                        this.updateLog('Push unsubscribe response (' + hostKey + '): ' + this.varToString(info), 2);
                        try { this.homey.settings.set(settingsKey, null); } catch (e) { /* ignore */ }

                        // Remove bucket
                        this.pushEvents.splice(pushEventIdx, 1);

                        Device.cam.removeAllListeners('event');
                        resolve(null);
                        return;
                    }
                });

                return;
            }

            // Devices still registered (or no ref). Keep subscription.
            if (pushEvent.devices.length === 0)
            {
                // No ref known; remove bucket anyway
                this.pushEvents.splice(pushEventIdx, 1);
            }
            this.updateLog('App.unsubscribe: Keep subscription as devices are still registered');

            Device.cam.removeAllListeners('event');
            resolve(null);
            return;
        });
    }


    hasPullSupport(capabilities, id)
    {
        if (capabilities && capabilities.events && capabilities.events.WSPullPointSupport && capabilities.events.WSPullPointSupport == true)
        {
            this.updateLog('Camera (' + id + ') supports PullPoint');
            return true;
        }

        this.updateLog('Camera (' + id + ') does NOT support PullPoint Events', 3);
        return false;
    }

    hasBaseEvents(services, id)
    {
        if (services && services.Capabilities && ((services.Capabilities.MaxNotificationProducers > 0) || (services.Capabilities.WSSubscriptionPolicySupport === true)))
        {
            this.updateLog('Camera (' + id + ') supports Push Events');
            return true;
        }

        this.updateLog('This camera (' + id + ') does NOT support Push Events', 0);
        return false;
    }

    stripNamespaces(topic)
    {
        // example input :-   tns1:MediaControl/tnsavg:ConfigurationUpdateAudioEncCfg
        // Split on '/'
        // For each part, remove any namespace
        // Recombine parts that were split with '/'
        let output = '';
        if (topic)
        {
            let parts = topic.split('/');
            for (let index = 0; index < parts.length; index++)
            {
                let stringNoNamespace = parts[index].split(':').pop(); // split on :, then return the last item in the array
                if (output.length == 0)
                {
                    output += stringNoNamespace;
                }
                else
                {
                    output += '/' + stringNoNamespace;
                }
            }
        }
        return output;
    }

    getUserDataPath(filename)
    {
        return path.join('/userdata', filename);
    }

    varToString(source)
    {
        try
        {
            if (source === null)
            {
                return 'null';
            }
            if (source === undefined)
            {
                return 'undefined';
            }
            if (source instanceof Error)
            {
                var stack = source.stack.replace(/\\n/g, '\n');
                stack = stack.replace(/\n/g, '\n         ');
                return `${source.message}\n      ${stack}`;
            }
            if (typeof(source) === 'object')
            {
                const getCircularReplacer = (homey) =>
                {
                    const seen = new WeakSet();
                    return (key, value) =>
                    {
                        if (typeof value === 'object' && value !== null)
                        {
                            if (seen.has(value) || value === homey)
                            {
                                return '';
                            }
                            seen.add(value);
                        }
                        return value;
                    };
                };

                return JSON.stringify(source, getCircularReplacer(this.homey), '\t');
            }
            if (typeof(source) === 'string')
            {
                return source;
            }
        }
        catch (err)
        {
            this.homey.app.updateLog(`VarToString Error: ${err.message}`, 0);
        }

        return source.toString();
    }

    updateLog(newMessage, logLevel = 2, insertBlankLine = false) 
    {
        if (logLevel > this.logLevel) return;

        // ---- Tuning knobs ----
        const MAX_CHARS = 200000;        // hard ceiling for diagLog string
        const TARGET_CHARS = 180000;     // trim down to this when exceeding MAX_CHARS (hysteresis)
        const MAX_LINES = 1200;          // ring-buffer-like: keep last N lines
        const MAX_MSG_CHARS = 2000;      // cap one message to prevent huge blobs
        // ----------------------

        // Normalize message early (avoid non-string surprises)
        let msg = (newMessage === undefined || newMessage === null) ? '' : String(newMessage);
        if (msg.length > MAX_MSG_CHARS) msg = msg.slice(0, MAX_MSG_CHARS) + ' …(truncated)';

        this.log(msg);

        const nowTime = new Date();
        const ms = String(nowTime.getMilliseconds()).padStart(3, '0');
        const ts = `${nowTime.getHours()}:${nowTime.getMinutes()}:${nowTime.getSeconds()}.${ms}`;

        let append = '';
        if (insertBlankLine) append += '\r\n';
        append += `${ts}: ${msg}\r\n`;

        let oldText = this.homey.settings.get('diagLog');

        // Daily header reset behavior preserved
        if (!oldText || oldText.length === 0 || (this.logDay !== nowTime.getDate())) {
            this.logDay = nowTime.getDate();
            oldText =
            'Log ID: ' + nowTime.toJSON() + '\r\n' +
            'App version ' + this.homey.manifest.version + '\r\n\r\n';
        }

        this.logLastTime = nowTime;

        let combined = oldText + append;

        // ---- Ring-buffer-like trimming by LINES first ----
        // Keep header, but ring only the body lines (after the first blank line block)
        // Header ends at the first double CRLF in your format: "\r\n\r\n"
        const headerSplit = combined.split('\r\n\r\n');
        let header = '';
        let body = combined;

        if (headerSplit.length >= 2) {
            // Reconstruct header exactly once
            header = headerSplit[0] + '\r\n\r\n';
            body = headerSplit.slice(1).join('\r\n\r\n'); // rest is body
        } else {
            // If format not as expected, treat everything as body
            header = '';
            body = combined;
        }

        // Split body into lines and keep last MAX_LINES (true ring-buffer behavior)
        // Note: split() produces an extra "" at end if body ends with \r\n; filter it out.
        let lines = body.split('\r\n').filter(l => l.length > 0);
        if (lines.length > MAX_LINES) {
            lines = lines.slice(lines.length - MAX_LINES);
        }

        combined = header + lines.join('\r\n') + '\r\n';

        // ---- Hard ceiling by CHARS (secondary safety net) ----
        if (combined.length > MAX_CHARS) {
            // Trim from the front (body only) down to TARGET_CHARS
            // Keep header if present
            const hLen = header.length;
            let bodyText = combined.slice(hLen);

            // If still too large, drop oldest chars to reach TARGET_CHARS total
            const allowedBodyLen = Math.max(0, TARGET_CHARS - hLen);
            if (bodyText.length > allowedBodyLen) {
            bodyText = bodyText.slice(bodyText.length - allowedBodyLen);

            // Ensure we start at a line boundary
            const firstNL = bodyText.indexOf('\n');
            if (firstNL >= 0) bodyText = bodyText.slice(firstNL + 1);
            }
            combined = header + bodyText;
        }

        this.homey.settings.set('diagLog', combined);
        }


    async sendLog({email = ''})
    {
        let tries = 5;

        while (tries-- > 0)
        {
            try
            {
                this.updateLog('Sending log', 0);
                // create reusable transporter object using the default SMTP transport
                let transporter = nodemailer.createTransport(
                    {
                        host: Homey.env.MAIL_HOST, //Homey.env.MAIL_HOST,
                        port: 465,
                        ignoreTLS: false,
                        secure: true, // true for 465, false for other ports
                        auth:
                    {
                        user: Homey.env.MAIL_USER, // generated ethereal user
                        pass: Homey.env.MAIL_SECRET // generated ethereal password
                    },
                        tls:
                    {
                        // do not fail on invalid certs
                        rejectUnauthorized: false
                    }
                    });

                // send mail with defined transport object
                let info = await transporter.sendMail(
                    {
                        from: '"Homey User" <' + Homey.env.MAIL_USER + '>', // sender address
                        to: Homey.env.MAIL_RECIPIENT, // list of receivers
                        subject: 'ONVIF log (' + this.homeyHash + ' : ' + this.homey.manifest.version + ')', // Subject line
                        text: email + '\n' + this.homey.settings.get('diagLog') // plain text body
                    });

                this.updateLog('Message sent: ' + info.messageId);
                // Message sent: <b658f8ca-6296-ccf4-8306-87d57a0b4321@example.com>

                // Preview only available when sending through an Ethereal account
                console.log('Preview URL: ', nodemailer.getTestMessageUrl(info));
                return '';
            }
            catch (err)
            {
                this.updateLog('Send log error: ' + err.message, 0);
            }
        }
        this.updateLog('Send log FAILED', 0);
        throw (new Error('Send log FAILED'));
    }

    async triggerMotion(tokens)
	{
		this.motionTrigger.trigger(tokens).catch(this.err);
    }

    async getPTZStatus(camObj) {
        try {
            // Vérifier les capacités PTZ de la caméra
            const capabilities = await this.getCapabilities(camObj);
            if (!capabilities || !capabilities.PTZ) {
                this.updateLog('Cette caméra ne supporte pas le PTZ', 0);
                return false;
            }

            // Les préréglages sont gérés directement par la librairie ONVIF
            return true;
        } catch (err) {
            this.updateLog('Erreur lors de la vérification PTZ: ' + err.message, 0);
            return false;
        }
    }

	checkSymVersionGreaterEqual(versionString, major, minor, patch) {
		const versionParts = versionString.split('.').map(num => parseInt(num, 10));
		if (versionParts.length < 3) {
			return false;
		}
		const [vMajor, vMinor, vPatch] = versionParts;
		return vMajor > major || (vMajor === major && vMinor > minor) || (vMajor === major && vMinor === minor && vPatch >= patch);
	}
}

module.exports = MyApp;