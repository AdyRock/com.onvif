'use strict';

if (process.env.DEBUG === '1')
{
    require('inspector').open(9222, '0.0.0.0', true)
}

const Homey = require('homey');
var onvif = require('/lib/onvif');
let Cam = require('/lib/onvif').Cam;
const parseSOAPString = require('/lib/onvif/lib/utils').parseSOAPString;
const linerase = require('/lib/onvif/lib/utils').linerase;
const path = require('path');
const nodemailer = require("nodemailer");

const http = require('http');
const
{
    captureMessage
} = require('homey-log/lib/Log');
const Log = require('homey-log').Log;

class MyApp extends Homey.App
{

    async onInit()
    {
        this.log('MyApp is running...');

        this.pushServerPort = 9998;
        this.discoveredDevices = [];
        this.discoveryInitialised = false;
        Homey.ManagerSettings.set('diagLog', "");
        Homey.ManagerSettings.set('sendLog', "");

        this.homeyId = await Homey.ManagerCloud.getHomeyId();
        this.homeyIP = await Homey.ManagerCloud.getLocalAddress();
        this.homeyIP = (this.homeyIP.split(":"))[0];

        this.pushEvents = [];

        Homey.ManagerSettings.on('set', (setting) =>
        {
            if (setting === 'sendLog' && (Homey.ManagerSettings.get('sendLog') === "send") && (Homey.ManagerSettings.get('diagLog') !== ""))
            {
                return this.sendLog();
            }
        });

        this.runsListener();

        this.checkCameras = this.checkCameras.bind(this);
        this.checkTimerId = setTimeout(this.checkCameras, 30000);
    }

    getMessageToken(message)
    {
        this.updateLog("Getting message token: " + this.varToString(message), 2);
        this.updateLog("Getting message token source: " + this.varToString(message.source), 2);
        if (message.source && message.source.simpleItem)
        {
            let simpleItem = message.source.simpleItem[0];
            this.updateLog("Getting message token simpleItem: " + this.varToString(simpleItem), 2);
            if (simpleItem && simpleItem["$"])
            {
                return simpleItem["$"].Value;
            }
        }

        return null;
    }

    async runsListener()
    {
        const requestListener = (request, response) =>
        {
            let pathParts = request.url.split(/\?|=/);

            if ((pathParts[1] === 'deviceId') && request.method === 'POST')
            {
                if (request.headers['content-type'].startsWith('application/soap+xml'))
                {
                    let body = '';
                    request.on('data', chunk =>
                    {
                        body += chunk.toString(); // convert Buffer to string
                        if (body.length > 10000)
                        {
                            this.updateLog("Push data error: Payload too large", 0);
                            response.writeHead(413);
                            response.end('Payload Too Large');
                            body = '';
                            return;
                        }
                    });
                    request.on('end', () =>
                    {
                        this.updateLog("Push Event detected: " + this.varToString(pathParts));
                        parseSOAPString(body, (err, res, xml) =>
                        {
                            if (!err && res)
                            {
                                var data = linerase(res).notify;

                                this.updateLog("Push Event data: " + this.varToString(data));

                                if (data && data.notificationMessage)
                                {
                                    if (!Array.isArray(data.notificationMessage))
                                    {
                                        data.notificationMessage = [data.notificationMessage];
                                    }

                                    this.updateLog("Push Event token message: " + this.varToString(data.notificationMessage[0].message.message));
                                    let messageToken = this.getMessageToken(data.notificationMessage[0].message.message);
                                    this.updateLog("Push Event Message Token: " + messageToken);

                                    // Find the referenced device
                                    this.updateLog("Push Event looking for: " + this.varToString(pathParts[2]));
                                    const driver = Homey.ManagerDrivers.getDriver('camera');
                                    var theDevice = null;
                                    if (driver)
                                    {
                                        let devices = driver.getDevices();
                                        for (var i = 0; i < devices.length; i++)
                                        {
                                            var device = devices[i];
                                            this.updateLog("Push Event comparing with ip: " + this.varToString(device.ip) + " Message Token: " + device.token);
                                            if (device.ip == pathParts[2])
                                            {
                                                // Correct IP so check the token for multiple cameras on this IP
                                                this.updateLog("Push Event found Device: " + pathParts[2]);
                                                if (!device.token || !messageToken || (messageToken == device.token))
                                                {
                                                    theDevice = device;
                                                    this.updateLog("Push Event found correct Device: " + device.token);
                                                    break;
                                                }
                                                else
                                                {
                                                    this.updateLog("Wrong channel token", 0);
                                                }
                                            }
                                        }
                                    }

                                    if (theDevice)
                                    {
                                        data.notificationMessage.forEach((message) =>
                                        {
                                            /**
                                             * Indicates message from device.
                                             * @event Cam#event
                                             * @type {Cam~NotificationMessage}
                                             */
                                            theDevice.processCamEventMessage(message);
                                        })
                                    }
                                    else
                                    {
                                        this.updateLog("Push Event unknown Device: " + pathParts[2], 0);
                                    }
                                }
                            }
                            else
                            {
                                this.updateLog("Push data error: " + err, 0);
                                response.writeHead(406);
                                response.end('Not Acceptable');
                                return;
                            }
                        });

                        response.writeHead(200);
                        response.end('ok');
                    });
                }
                else
                {
                    this.updateLog("Push data invalid content type: " + request.headers['content-type'], 0);
                    response.writeHead(415);
                    response.end('Unsupported Media Type');
                }
            }
            else
            {
                this.updateLog("Push data error: " + request.url + ": METHOD = " + request.method, 0);
                response.writeHead(405);
                response.end('Method not allowed');
            }
        }

        const server = http.createServer(requestListener);
        server.listen(this.pushServerPort);
    }

    async discoverCameras()
    {
        this.discoveredDevices = [];
        let cams = [];
        this.updateLog('====  Discovery Starting  ====');
        if (!this.discoveryInitialised)
        {
            this.discoveryInitialised = true;
            onvif.Discovery.on('device', async (cam, rinfo, xml) =>
            {
                try
                {
                    // function will be called as soon as NVT responds
                    this.updateLog('Reply from ' + this.varToString(cam));
                    cams.push(cam);

                    if (cam.href && cam.href.indexOf("onvif") >= 0)
                    {
                        var mac = await Homey.ManagerArp.getMAC(cam.hostname);

                        this.discoveredDevices.push(
                        {
                            "name": cam.hostname,
                            data:
                            {
                                "id": mac
                            },
                            settings:
                            {
                                // Store username & password in settings
                                // so the user can change them later
                                "username": "",
                                "password": "",
                                "ip": cam.hostname,
                                "port": cam.port ? cam.port.toString() : "",
                                "urn": mac,
                                "channel": -1,
                            }
                        })
                    }
                    else
                    {
                        this.updateLog("Discovery (" + cam.hostname + "): Invalid service URI", 0);
                    }
                }
                catch (err)
                {
                    this.updateLog("Discovery catch error: " + err.message + "\n" + err.stack, 0);
                }
            })

            onvif.Discovery.on('error', (msg, xml) =>
            {
                this.updateLog("Discovery on error: " + this.varToString(msg), 0);
                if (xml)
                {
                    this.updateLog("xml: " + this.varToString(xml), 2);
                }
            })
        }

        // Start the discovery process running
        onvif.Discovery.probe(
        {
            'resolve': false
        });

        // Allow time for the process to finish
        await new Promise(resolve => setTimeout(resolve, 10000));



        // Add in a manual option

        
        this.updateLog('====  Discovery Finished  ====');
        let devices = this.discoveredDevices;

        Log.setExtra(
        {
            "cams": cams
        });

        this.discoveredDevices = [];
        return devices;
    }

    connectCamera(hostname, port, username, password)
    {
        return new Promise((resolve, reject) =>
        {
            try
            {
                this.updateLog("--------------------------");
                this.updateLog('Connect to Camera ' + hostname + ':' + port + " - " + username);

                let cam = new Cam(
                {
                    hostname: hostname,
                    username: username,
                    password: password,
                    port: parseInt(port),
                    timeout: 70000,
                }, (err) =>
                {
                    if (err)
                    {
                        this.updateLog('Connection Failed for ' + hostname + ' Port: ' + port + ' Username: ' + username, 0);
                        return reject(err);
                    }
                    else
                    {
                        this.updateLog('CONNECTED to ' + hostname);
                        return resolve(cam);
                    }
                });
            }
            catch (err)
            {
                this.updateLog("Connect to camera " + hostname + " error: " + err.stack, 0);
                return reject(err);
            }
        });
    }

    async checkCameras()
    {
        const driver = Homey.ManagerDrivers.getDriver('camera');
        if (driver)
        {
            let devices = driver.getDevices();
            for (var i = 0; i < devices.length; i++)
            {
                var device = devices[i];
                await device.checkCamera();
            }
        }

        this.checkCameras = this.checkCameras.bind(this);
        this.checkTimerId = setTimeout(this.checkCameras, 10000);
    }

    getHostName(cam_obj)
    {
        return new Promise((resolve, reject) =>
        {
            try
            {
                cam_obj.getHostname((err, date, xml) =>
                {
                    if (err)
                    {
                        return reject(err);
                    }
                    else
                    {
                        return resolve(date);
                    }
                });
            }
            catch (err)
            {
                return reject(err);
            }
        });
    }

    getDateAndTime(cam_obj)
    {
        return new Promise((resolve, reject) =>
        {
            try
            {
                cam_obj.getSystemDateAndTime((err, date, xml) =>
                {
                    if (err)
                    {
                        return reject(err);
                    }
                    else
                    {
                        return resolve(date);
                    }
                });
            }
            catch (err)
            {
                return reject(err);
            }
        });
    }

    getDeviceInformation(cam_obj)
    {
        return new Promise((resolve, reject) =>
        {
            try
            {
                cam_obj.getDeviceInformation((err, info, xml) =>
                {
                    if (err)
                    {
                        return reject(err);
                    }
                    else
                    {
                        return resolve(info);
                    }
                });
            }
            catch (err)
            {
                return reject(err);
            }
        });
    }

    getCapabilities(cam_obj)
    {
        return new Promise((resolve, reject) =>
        {
            try
            {
                cam_obj.getCapabilities((err, info, xml) =>
                {
                    if (err)
                    {
                        return reject(err);
                    }
                    else
                    {
                        return resolve(info);
                    }
                });
            }
            catch (err)
            {
                return reject(err);
            }
        });
    }

    getServices(cam_obj)
    {
        return new Promise((resolve, reject) =>
        {
            try
            {
                cam_obj.getServices(true, (err, info, xml) =>
                {
                    if (err)
                    {
                        return reject(err);
                    }
                    else
                    {
                        return resolve(info);
                    }
                });
            }
            catch (err)
            {
                return reject(err);
            }
        });
    }

    getSnapshotURL(cam_obj)
    {
        return new Promise((resolve, reject) =>
        {
            try
            {
                cam_obj.getSnapshotUri((err, info, xml) =>
                {
                    if (err)
                    {
                        return reject(err);
                    }
                    else
                    {
                        return resolve(info);
                    }
                });
            }
            catch (err)
            {
                return reject(err);
            }
        });
    }

    hasEventTopics(cam_obj)
    {
        return new Promise((resolve, reject) =>
        {
            try
            {
                let supportedEvents = [];
                cam_obj.getEventProperties((err, data, xml) =>
                {
                    if (err)
                    {
                        return reject(err);
                    }
                    else
                    {
                        // Display the available Topics
                        let parseNode = (node, topicPath, nodeName) =>
                        {
                            // loop over all the child nodes in this node
                            for (const child in node)
                            {
                                if (child == "$")
                                {
                                    continue;
                                }
                                else if (child == "messageDescription")
                                {
                                    // we have found the details that go with an event
                                    supportedEvents.push(nodeName.toUpperCase());
                                    return;
                                }
                                else
                                {
                                    // descend into the child node, looking for the messageDescription
                                    parseNode(node[child], topicPath + '/' + child, child)
                                }
                            }
                        }
                        parseNode(data.topicSet, '', '')
                    }
                    return resolve(supportedEvents);
                });
            }
            catch (err)
            {
                return reject(err);
            }
        });
    }

    subscribeToCamPushEvents(Device)
    {
        return new Promise((resolve, reject) =>
        {

            this.updateLog("App.subscribeToCamPushEvents: " + Device.id);

            let unsubscribeRef = null
            let pushEvent = this.pushEvents.find(element => element.devices[0].length> 0 && element.devices[0].cam.hostname == Device.cam.hostname);
            if (pushEvent)
            {
                this.updateLog("App.subscribeToCamPushEvents: Found entry for " + Device.cam.hostname);
                // An event is already registered for this IP address
                clearTimeout(pushEvent.eventSubscriptionRenewTimerId);
                unsubscribeRef = pushEvent.unsubscribeRef;
                pushEvent.eventSubscriptionRenewTimerId = null;

                // see if this device is registered
                if (!pushEvent.devices.find(element => element.id == Device.id))
                {
                    this.updateLog("App.subscribeToCamPushEvents: Adding device " + Device.id + " to the queue");
                    pushEvent.devices.push(Device);
                }
            }
            else
            {
                this.updateLog("App.subscribeToCamPushEvents: Registering " + Device.cam.hostname);
                pushEvent = {
                    "devices": [],
                    "refreshTime": 0,
                    "unsubscribeRef": unsubscribeRef,
                    "eventSubscriptionRenewTimerId": null
                };
                pushEvent.devices.push(Device);
                this.pushEvents.push(pushEvent);
            }

            if (unsubscribeRef)
            {
                this.updateLog("Renew previous events: " + unsubscribeRef);
                Device.cam.RenewPushEventSubscription(unsubscribeRef, (err, info, xml) =>
                {
                    if (err)
                    {
                        this.updateLog("Renew subscription err (" + Device.id + "): " + err, 0);
                        console.log(err);
						// Refresh was probably too late so subscribe again
						pushEvent.unsubscribeRef = null;
						setImmediate(() =>
                        {
                            this.updateLog("Resubscribing");
                            this.subscribeToCamPushEvents(Device);
                        });
                        return resolve(true);
                    }
                    else
                    {
                        this.updateLog("Renew subscription response (" + Device.id + "): " + Device.cam.hostname + "info: " + this.varToString(info));
                        let startTime = info[0].renewResponse[0].currentTime[0];
                        let endTime = info[0].renewResponse[0].terminationTime[0];
                        var d1 = new Date(startTime);
                        var d2 = new Date(endTime);
                        var refreshTime = ((d2.valueOf() - d1.valueOf())) - 5000;

                        this.updateLog("Push renew every (" + Device.id + "): " + refreshTime);
                        if (refreshTime < 5000)
                        {
                            refreshTime += 5000;
                        }

                        pushEvent.refreshTime = refreshTime;
                        pushEvent.unsubscribeRef = unsubscribeRef;
                        pushEvent.eventSubscriptionRenewTimerId = setTimeout(() =>
                        {
                            this.updateLog("Renewing subscription");
                            this.subscribeToCamPushEvents(Device);
                        }, refreshTime);
                        return resolve(true);
                    }
                });
            }
            else
            {
                const url = "http://" + this.homeyIP + ":" + this.pushServerPort + "/onvif/events?deviceId=" + Device.cam.hostname;
                this.updateLog("Setting up Push events (" + Device.id + ") on: " + url);
                Device.cam.SubscribeToPushEvents(url, (err, info, xml) =>
                {
                    if (err)
                    {
                        this.updateLog("Subscribe err (" + Device.id + "): " + err, 0);
                        return resolve(false);
                    }
                    else
                    {

                        this.updateLog("Subscribe response (" + Device.id + "): " + Device.cam.hostname + " - Info: " + this.varToString(info));
                        unsubscribeRef = info[0].subscribeResponse[0].subscriptionReference[0].address[0];

                        let startTime = info[0].subscribeResponse[0].currentTime[0];
                        let endTime = info[0].subscribeResponse[0].terminationTime[0];
                        var d1 = new Date(startTime);
                        var d2 = new Date(endTime);
                        var refreshTime = ((d2.valueOf() - d1.valueOf())) - 5000;

                        this.updateLog("Push renew every (" + Device.id + "): " + refreshTime);
                        if (refreshTime < 5000)
                        {
                            refreshTime += 5000;
                        }

                        pushEvent.refreshTime = refreshTime;
                        pushEvent.unsubscribeRef = unsubscribeRef;
                        pushEvent.eventSubscriptionRenewTimerId = setTimeout(() =>
                        {
                            this.updateLog("Renewing subscription");
                            this.subscribeToCamPushEvents(Device);
                        }, refreshTime);
                        return resolve(true);
                    }
                });
            }
        });
    }

    unsubscribe(Device)
    {
        return new Promise((resolve, reject) =>
        {
            this.updateLog("App.unsubscribe: " + Device.id);
            let deviceIdx = -1;
            let pushEvent = null;
            let pushEventIdx = this.pushEvents.findIndex(element => (element.devices[0] && (element.devices[0].cam.hostname == Device.cam.hostname)));
            console.log("pushEvent Idx = ", pushEventIdx);
            if (pushEventIdx >= 0)
            {
                this.updateLog("App.unsubscribe: Found entry for " + Device.cam.hostname);
                pushEvent = this.pushEvents[pushEventIdx]
                // see if this device is registered
                deviceIdx = pushEvent.devices.findIndex(element => element.id == Device.id);
                if (deviceIdx < 0)
                {
                    // Not registered so do nothing
                    this.updateLog("App.unsubscribe: No Push entry for device: " + Device.id);
                    return resolve(null);
                }
            }
            else
            {
//                this.updateLog("App.unsubscribe: No Push entry for host: " + Device.cam.hostname, 0);
                Device.cam.removeAllListeners('event');
                return resolve(null);
            }

            // Remove this device reference
            this.updateLog("App.unsubscribe: Unregister entry for " + Device.id);
            pushEvent.devices.splice(deviceIdx, 1);

            if ((pushEvent.devices.length == 0) && pushEvent.unsubscribeRef)
            {
                // No devices left so unregister the event
                clearTimeout(pushEvent.eventSubscriptionRenewTimerId);
                this.updateLog('Unsubscribe push event (' + Device.cam.hostname + '): ' + pushEvent.unsubscribeRef);
                Device.cam.UnsubscribePushEventSubscription(pushEvent.unsubscribeRef, (err, info, xml) =>
                {
                    if (err)
                    {
                        this.updateLog("Push unsubscribe error (" + Device.cam.hostname + "): " + this.varToString(err), true);
                    }
                    else
                    {
                        this.updateLog("Push unsubscribe response (" + Device.cam.hostname + "): " + this.varToString(info));
                    }

                    // remove the push event from the list
                    this.pushEvents.splice(pushEventIdx, 1);

                    Device.cam.removeAllListeners('event');
                    return resolve(null);
                });
            }
            else
            {
                this.updateLog('App.unsubscribe: Keep subscription as devices are still registered');

                Device.cam.removeAllListeners('event');
                return resolve(null);
            }
        });
    }

    hasPullSupport(capabilities, id)
    {
        if (capabilities && capabilities.events && capabilities.events.WSPullPointSupport && capabilities.events.WSPullPointSupport == true)
        {
            this.updateLog('Camera (' + id + ') supports PullPoint');
            return true;
        }

        this.updateLog('Camera (' + id + ') does NOT support PullPoint Events', 0);
        return false
    }

    hasBaseEvents(services, id)
    {
        if (services && services.Capabilities && services.Capabilities.MaxNotificationProducers > 0)
        {
            this.updateLog('Camera (' + id + ') supports Push Events');
            return true;
        }

        this.updateLog('This camera (' + id + ') does NOT support Push Events', 0);
        return false
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
            let parts = topic.split('/')
            for (let index = 0; index < parts.length; index++)
            {
                let stringNoNamespace = parts[index].split(':').pop() // split on :, then return the last item in the array
                if (output.length == 0)
                {
                    output += stringNoNamespace
                }
                else
                {
                    output += '/' + stringNoNamespace
                }
            }
        }
        return output
    }

    getUserDataPath(filename)
    {
        return path.join(__dirname, 'userdata', filename);
    }

    varToString(source)
    {
        if (source === null)
        {
            return "null";
        }
        if (source === undefined)
        {
            return "undefined";
        }
        if (source instanceof Error)
        {
            let stack = source.stack.replace('/\\n/g', '\n');
            return source.message + '\n' + stack;
        }
        if (typeof(source) === "object")
        {
            return JSON.stringify(source, null, 2);
        }
        if (typeof(source) === "string")
        {
            return source;
        }

        return source.toString();
    }

    updateLog(newMessage, ignoreSetting = 1)
    {
        if (ignoreSetting > Homey.ManagerSettings.get('logLevel'))
        {
            return;
        }

        this.log(newMessage);

        var oldText = Homey.ManagerSettings.get('diagLog');
        if (oldText.length > 30000)
        {
            // Remove the first 5000 characters.
            oldText = oldText.substring( 1000 );
            var n = oldText.indexOf( "\n" );
            if ( n >= 0 )
            {
                // Remove up to and including the first \n so the log starts on a whole line
                oldText = oldText.substring( n + 1 );
            }
        }

        const nowTime = new Date(Date.now());

        if (oldText.length == 0)
        {
            oldText = "Log ID: ";
            oldText += nowTime.toJSON();
            oldText += "\r\n";
            oldText += "App version ";
            oldText += Homey.manifest.version;
            oldText += "\r\n\r\n";
            this.logLastTime = nowTime;
        }

        let dt = new Date(nowTime.getTime() - this.logLastTime.getTime());
        this.logLastTime = nowTime;

        oldText += "+";
        oldText += (dt.getHours() - 1);
        oldText += ":";
        oldText += dt.getMinutes();
        oldText += ":";
        oldText += dt.getSeconds();
        oldText += ".";
        let milliSeconds = dt.getMilliseconds().toString();
        if (milliSeconds.length == 2)
        {
            oldText += '0';
        }
        else if (milliSeconds.length == 1)
        {
            oldText += '00';
        }
        oldText += milliSeconds;
        oldText += ": ";
        oldText += newMessage;
        oldText += "\r\n";
        Homey.ManagerSettings.set('diagLog', oldText);
        Log.setExtra(
        {
            "diagLog": Homey.ManagerSettings.get('diagLog')
        });
        Homey.ManagerSettings.set('sendLog', "");
    }

    async sendLog()
    {
        let tries = 5;

        while (tries-- > 0)
        {
            try
            {
                this.updateLog("Sending log", 0);
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
                    subject: "ONVIF log", // Subject line
                    text: Homey.ManagerSettings.get('diagLog') // plain text body
                });

                this.updateLog("Message sent: " + info.messageId);
                // Message sent: <b658f8ca-6296-ccf4-8306-87d57a0b4321@example.com>

                // Preview only available when sending through an Ethereal account
                console.log("Preview URL: ", nodemailer.getTestMessageUrl(info));
                return "";
            }
            catch (err)
            {
                this.updateLog("Send log error: " + err.stack), 0;
            };
        }
        this.updateLog("Send log FAILED", 0);
    }
}

module.exports = MyApp;