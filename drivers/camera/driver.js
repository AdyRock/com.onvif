/*jslint node: true */
'use strict';

const Homey = require('homey');

class CameraDriver extends Homey.Driver
{

    onInit()
    {
        this.log('CameraDriver has been inited');
        this.lastUsername = '';
        this.lastPassword = '';
        this.lastHostName = '';
        this.lastPort = 0;
        this.lastURN = "";

        this.motionEnabledTrigger = this.homey.flow.getDeviceTriggerCard('motionEnabledTrigger');
        this.motionDisabledTrigger = this.homey.flow.getDeviceTriggerCard('motionDisabledTrigger');
        this.snapshotReadyTrigger = this.homey.flow.getDeviceTriggerCard('snapshotReadyTrigger');
        this.eventShotReadyTrigger = this.homey.flow.getDeviceTriggerCard('eventShotReadyTrigger');
    }

    async onPair(session)
    {
        let listDevices = 1;
        let tempCam = null;
        this.lastURN = null;

        session.setHandler('list_devices', async () =>
        {
            if (listDevices == 1)
            {
                listDevices = 2;
                let devices = await this.homey.app.discoverCameras();
                this.homey.app.updateLog("Discovered: " + this.homey.app.varToString(devices, null, 3));

                // Add the manual entry
                devices.push(
                {
                    "name": "Add Manually",
                    data:
                    {
                        "id": "manual"
                    },
                    settings:
                    {
                        // Store username & password in settings
                        // so the user can change them later
                        "username": "",
                        "password": "",
                        "ip": "",
                        "port": "",
                        "urn": "",
                        "channel": -1
                    }
                });

                return devices;
            }
            else
            {
                if (tempCam)
                {
                    this.homey.app.updateLog("list_devices2: Multiple Sources ", tempCam.videoSources);

                    let devices = [];
                    for (let i = 0; i < tempCam.videoSources.length; i++)
                    {
                        const source = tempCam.videoSources[i];
                        // There is more tha 1 video source so add a device for each
                        this.homey.app.updateLog("Adding source " + source + " to list");
                        let token = "";
                        if (source.$)
                        {
                            token = source.$.token;
                        }
                        let channelSuf = " (Ch" + (devices.length + 1) + ")";
                        let data = {
                            "id": this.lastURN + channelSuf,
                            "port": this.lastPort
                        };
                        devices.push(
                        {
                            "name": this.lastHostName + channelSuf,
                            data,
                            settings:
                            {
                                // Store username & password in settings
                                // so the user can change them later
                                "username": this.lastUsername,
                                "password": this.lastPassword,
                                "ip": this.lastHostName,
                                "port": this.lastPort,
                                "urn": this.lastURN,
                                "channel": devices.length + 1,
                                "token": token
                            }
                        });
                    }
                    this.homey.app.updateLog("list_devices2: Listing ", devices);
                    return devices;
                }
                else
                {
                    this.homey.app.updateLog("list_devices2: Single Sources");
                    session.nextView();
                }
            }
        });

        session.setHandler('list_devices_selection', async (data) =>
        {
            // User selected a device so cache the information required to validate it when the credentials are set
            console.log("list_devices_selection: ", data);
            this.lastHostName = data[0].settings.ip;
            this.lastPort = data[0].settings.port;
            this.lastURN = data[0].settings.urn;
            return;
        });

        session.setHandler('manual_connection_setup', async () =>
        {
            let loginInfo = {
                username: this.lastUsername,
                password: this.lastPassword,
                ip: this.lastHostName,
                port: this.lastPort
            };

            return loginInfo;
        });

        session.setHandler('manual_connection', async (data) =>
        {
            this.lastUsername = data.username;
            this.lastPassword = data.password;
            this.lastHostName = data.ip;
            this.lastPort = data.port;

            if (!this.lastURN)
            {
                this.lastURN = await this.homey.arp.getMAC(this.lastHostName);
                if (!this.lastURN)
                {
                    this.lastURN = Date.now().toString();
                }
            }

            this.homey.app.updateLog("Login-----");

            let cam = await this.homey.app.connectCamera(
                this.lastHostName,
                this.lastPort,
                this.lastUsername,
                this.lastPassword
            );

            this.homey.app.updateLog("Credentials OK. Adding " + this.homey.app.varToString(cam.videoSources));

            if (Array.isArray(cam.videoSources) && (cam.videoSources.length > 1))
            {
                // There is more tha 1 video source so show the list for the user to select
                this.homey.app.updateLog("Multiple source found. Adding " + cam.videoSources.length + " more devices");
                tempCam = cam;
                listDevices = 2;

                return null;
            }
            else
            {
                if (cam.path && cam.path.indexOf("onvif") >= 0)
                {
                    let device = (
                    {
                        "name": cam.hostname,
                        data:
                        {
                            "id": this.lastURN
                        },
                        settings:
                        {
                            // Store username & password in settings
                            // so the user can change them later
                            "username": this.lastUsername,
                            "password": this.lastPassword,
                            "ip": cam.hostname,
                            "port": cam.port ? cam.port.toString() : "",
                            "urn": this.lastURN,
                            "channel": -1
                        }
                    });
                    return device;
                }
                else
                {
                    throw new Error("Discovery (" + cam.hostname + "): Invalid service URI", null);
                }
            }
        });
    }

    async onRepair(session, device)
    {
        // Argument socket is an EventEmitter, similar to Driver.onPair
        // Argument device is a this.homey.Device that's being repaired

        device.repairing = true;

        session.setHandler('repair_connection_setup', async (data) =>
        {
            let loginInfo = {
                username: device.username,
                password: device.password,
                ip: device.ip,
                port: device.port
            };

            return loginInfo;
        });

        session.setHandler('repair_connection', async (data) =>
        {
            await device.setSettings(
            {
                'username': data.username,
                'password': data.password,
                "ip": data.ip,
                "port": data.port,
                "enabled": true
            });

            let settings = device.getSettings();
            let devices = await this.homey.app.discoverCameras();

            console.log("Discovered devices: ", devices);

            let matched = false;

            for (let discoveredDevice of devices)
            {
                try
                {
                    let cam = await this.homey.app.connectCamera(
                        discoveredDevice.settings.ip,
                        discoveredDevice.settings.port,
                        settings.username,
                        settings.password
                    );

                    let info = {};
                    try
                    {
                        info = await this.homey.app.getDeviceInformation(cam);
                        this.homey.app.updateLog("Camera Information: " + this.homey.app.varToString(info));
                    }
                    catch (err)
                    {
                        this.homey.app.updateLog("Get camera info error: " + this.homey.app.varToString(err), 0);
                        return;
                    }

                    if ((info.serialNumber === settings.serialNumber) && (info.model === settings.model))
                    {
                        matched = true;
                    }

                    if (matched)
                    {
                        // found it
                        await device.setSettings(
                        {
                            'ip': discoveredDevice.settings.ip,
                            'port': discoveredDevice.settings.port
                        });
                        device.cam = cam;
                        device.setupImages();

                        this.homey.app.updateLog("Found the camera: " + this.homey.app.varToString(info));
                        device.setAvailable().catch(this.error);
                        break;
                    }
                }
                catch (err)
                {
                    this.homey.app.updateLog("Get camera info error: " + this.homey.app.varToString(err));
                }
            }

            if (matched)
            {
                return true;
            }
            else
            {
                return false;
            }
        });

        session.setHandler('disconnect', async () =>
        {
            // Cleanup
            device.repairing = false;
        });

    }
}

module.exports = CameraDriver;