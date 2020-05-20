'use strict';

const Homey = require('homey');
var onvif = require('/lib/onvif');
let Cam = require('/lib/onvif').Cam;
const parseSOAPString = require('/lib/onvif/lib/utils').parseSOAPString;
const linerase = require('/lib/onvif/lib/utils').linerase;
const path = require('path');
const nodemailer = require("nodemailer");

const http = require('http');

class MyApp extends Homey.App {

	async onInit() {
		this.log('MyApp is running...');
		this.pushServerPort = 9998;
		this.discoveredDevices = [];
		this.discoveryInitialised = false;
		Homey.ManagerSettings.set('diagLog', "");
		Homey.ManagerSettings.set('sendLog', "");

		this.homeyId = await Homey.ManagerCloud.getHomeyId();
		this.homeyIP = await Homey.ManagerCloud.getLocalAddress();
		this.homeyIP = (this.homeyIP.split(":"))[0];

		Homey.ManagerSettings.on('set', (setting) => {
			if (setting === 'sendLog' && (Homey.ManagerSettings.get('sendLog') === "send") && (Homey.ManagerSettings.get('diagLog') !== "")) {
				return Homey.app.sendLog();
			}
		});

		this.runsListener();
	}

	async runsListener() {
		const requestListener = (request, response) => {
			let pathParts = request.url.split(/\?|=/);

			if ((pathParts[1] === 'deviceId') && request.method === 'POST') {
				if (request.headers['content-type'].startsWith('application/soap+xml')) {
					let body = '';
					request.on('data', chunk => {
						body += chunk.toString(); // convert Buffer to string
						if (body.length > 10000) {
							this.updateLog("Push data error: Payload too large", true);
							response.writeHead(413);
							response.end('Payload Too Large');
							body = '';
							return;
						}
					});
					request.on('end', () => {
						parseSOAPString(body, (err, res, xml) => {
							if (!err && res) {
								var data = linerase(res).notify;

								if (data && data.notificationMessage) {
									if (!Array.isArray(data.notificationMessage)) {
										data.notificationMessage = [data.notificationMessage];
									}

									// Find the referenced device
									const driver = Homey.ManagerDrivers.getDriver('camera');
									var theDevice = null;
									if (driver) {
										let devices = driver.getDevices();
										for (var i = 0; i < devices.length; i++) {
											var device = devices[i];
											if (device.getData().id == pathParts[2]) {
												Homey.app.updateLog("Push Event found Device: " + pathParts[2]);
												theDevice = device;
												break;
											}
										}
									}

									console.log(" ");

									if (theDevice) {
										data.notificationMessage.forEach((message) => {
											/**
											 * Indicates message from device.
											 * @event Cam#event
											 * @type {Cam~NotificationMessage}
											 */
											theDevice.processCamEventMessage(message);
										})
									} else {
										Homey.app.updateLog("Push Event unknown Device: " + pathParts[2]);
									}
								}
							} else {
								this.updateLog("Push data error: " + err, true);
								response.writeHead(406);
								response.end('Not Acceptable');
								return;
							}
						});

						response.writeHead(200);
						response.end('ok');
					});
				} else {
					this.updateLog("Push data invalid content type: " + request.headers['content-type'], true);
					response.writeHead(415);
					response.end('Unsupported Media Type');
				}
			} else {
				this.updateLog("Push data error: " + request.url + ": METHOD = " + request.method, true);
				response.writeHead(405);
				response.end('Method not allowed');
			}
		}

		const server = http.createServer(requestListener);
		server.listen(this.pushServerPort);
	}

	async discoverCameras() {
		this.discoveredDevices = [];
		Homey.app.updateLog('====  Discovery Starting  ====');
		if (!this.discoveryInitialised) {
			this.discoveryInitialised = true;
			onvif.Discovery.on('device', (cam, rinfo, xml) => {
				try {
					// function will be called as soon as NVT responds
					Homey.app.updateLog('Reply from ' + Homey.app.varToString(cam));

					var data = {};
					data = {
						"id": cam.hostname,
						"port": cam.port
					};
					this.discoveredDevices.push({
						"name": cam.hostname,
						data,
						settings: {
							// Store username & password in settings
							// so the user can change them later
							"username": "",
							"password": "",
							"ip": cam.hostname,
							"port": cam.port ? cam.port.toString() : "",
						}
					})
				} catch (err) {
					Homey.app.updateLog("Discovery error: " + err.stack, true);
				}
			})

			onvif.Discovery.on('error', (msg, xml) => {
				Homey.app.updateLog("Discovery error: " + Homey.app.varToString(msg), true);
				if (xml) {
					Homey.app.updateLog("xml: " + Homey.app.varToString(xml));
				}
			})
		}

		// Start the discovery process running
		onvif.Discovery.probe({
			'resolve': false
		});

		// Allow time for the process to finish
		await new Promise(resolve => setTimeout(resolve, 5000));
		Homey.app.updateLog('====  Discovery Finished  ====');
		let devices = this.discoveredDevices;
		this.discoveredDevices = [];
		return devices;
	}

	async connectCamera(hostName, port, username, password) {
		return new Promise((resolve, reject) => {
			try {
				Homey.app.updateLog("--------------------------");
				Homey.app.updateLog('Connect to Camera ' + hostName + ':' + port + " - " + username);

				let cam = new Cam({
					hostname: hostName,
					username: username,
					password: password,
					port: parseInt(port),
					timeout: 70000,
				}, (err) => {
					if (err) {
						Homey.app.updateLog('Connection Failed for ' + hostName + ' Port: ' + port + ' Username: ' + username, true);
						return reject(err);
					} else {
						Homey.app.updateLog('CONNECTED to ' + hostName);
						return resolve(cam);
					}
				});
			} catch (err) {
				Homey.app.updateLog("Connect to camera " + hostName + " error: " + err.stack, true);
				return reject(err);
			}
		});
	}

	async getDateAndTime(cam_obj) {
		return new Promise((resolve, reject) => {
			try {
				cam_obj.getSystemDateAndTime((err, date, xml) => {
					if (err) {
						return reject(err);
					} else {
						return resolve(date);
					}
				});
			} catch (err) {
				return reject(err);
			}
		});
	}

	async getDeviceInformation(cam_obj) {
		return new Promise((resolve, reject) => {
			try {
				cam_obj.getDeviceInformation((err, info, xml) => {
					if (err) {
						return reject(err);
					} else {
						return resolve(info);
					}
				});
			} catch (err) {
				return reject(err);
			}
		});
	}

	async getCapabilities(cam_obj) {
		return new Promise((resolve, reject) => {
			try {
				cam_obj.getCapabilities((err, info, xml) => {
					if (err) {
						return reject(err);
					} else {
						return resolve(info);
					}
				});
			} catch (err) {
				return reject(err);
			}
		});
	}

	async getServices(cam_obj) {
		return new Promise((resolve, reject) => {
			try {
				cam_obj.getServices(true, (err, info, xml) => {
					if (err) {
						return reject(err);
					} else {
						return resolve(info);
					}
				});
			} catch (err) {
				return reject(err);
			}
		});
	}

	async getSnapshotURL(cam_obj) {
		return new Promise((resolve, reject) => {
			try {
				cam_obj.getSnapshotUri((err, info, xml) => {
					if (err) {
						return reject(err);
					} else {
						return resolve(info);
					}
				});
			} catch (err) {
				return reject(err);
			}
		});
	}

	async hasEventTopics(cam_obj) {
		return new Promise((resolve, reject) => {
			try {
				let supportedEvents = [];
				cam_obj.getEventProperties((err, data, xml) => {
					if (err) {
						return reject(err);
					} else {
						// Display the available Topics
						let parseNode = (node, topicPath, nodeName) => {
							// loop over all the child nodes in this node
							for (const child in node) {
								if (child == "$") {
									continue;
								} else if (child == "messageDescription") {
									// we have found the details that go with an event
									supportedEvents.push(nodeName.toUpperCase());
									return;
								} else {
									// descend into the child node, looking for the messageDescription
									parseNode(node[child], topicPath + '/' + child, child)
								}
							}
						}
						parseNode(data.topicSet, '', '')
					}
					return resolve(supportedEvents);
				});
			} catch (err) {
				return reject(err);
			}
		});
	}

	async unsubscribe(cam_obj, unsubscribeRef) {
		return new Promise((resolve, reject) => {
			if (unsubscribeRef) {
				Homey.app.updateLog('Unsubscribe push event (' + cam_obj.hostname + '): ' + unsubscribeRef);
				cam_obj.UnsubscribePushEventSubscription(unsubscribeRef, (err, info, xml) => {
					if (err) {
						Homey.app.updateLog("Push unsubscribe error (" + cam_obj.hostname + "): " + err, true);
						return reject(err);
					}

					return resolve(null);
				});
			} else {
				Homey.app.updateLog('Unsubscribe Pull event (' + cam_obj.hostname + ')');
				cam_obj.removeAllListeners('event');
				return resolve(null);
			}
		});
	}

	hasPullSupport(capabilities, id) {
		if (capabilities.events && capabilities.events.WSPullPointSupport && capabilities.events.WSPullPointSupport == true) {
			Homey.app.updateLog('Camera (' + id + ') supports PullPoint');
			return true;
		}

		Homey.app.updateLog('Camera (' + id + ') does NOT support PullPoint Events', true);
		return false
	}

	hasBaseEvents(services, id) {
		if (services.Capabilities && services.Capabilities.MaxNotificationProducers > 0) {
			Homey.app.updateLog('Camera (' + id + ') supports Push Events');
			return true;
		}

		Homey.app.updateLog('This camera (' + id + ') does NOT support Push Events', true);
		return false
	}

	stripNamespaces(topic) {
		// example input :-   tns1:MediaControl/tnsavg:ConfigurationUpdateAudioEncCfg 
		// Split on '/'
		// For each part, remove any namespace
		// Recombine parts that were split with '/'
		let output = '';
		let parts = topic.split('/')
		for (let index = 0; index < parts.length; index++) {
			let stringNoNamespace = parts[index].split(':').pop() // split on :, then return the last item in the array
			if (output.length == 0) {
				output += stringNoNamespace
			} else {
				output += '/' + stringNoNamespace
			}
		}
		return output
	}

	getUserDataPath(filename) {
		return path.join(__dirname, 'userdata', filename);
	}

	varToString(source) {
		if (source === null) {
			return "null";
		}
		if (source === undefined) {
			return "undefined";
		}
		if (typeof (source) === "object") {
			return JSON.stringify(source, null, 2);
		}
		if (typeof (source) === "string") {
			return source;
		}

		return source.toString();
	}

	updateLog(newMessage, ignoreSetting) {
		if (!ignoreSetting && !Homey.ManagerSettings.get('logEnabled')) {
			return;
		}

		this.log(newMessage);
		var oldText = Homey.ManagerSettings.get('diagLog');
		if (oldText.length > 30000) {
			oldText = "";
		}

		const nowTime = new Date(Date.now());

		if (oldText.length == 0) {
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
		oldText += dt.getMilliseconds();
		oldText += ": ";
		oldText += newMessage;
		oldText += "\r\n";
		Homey.ManagerSettings.set('diagLog', oldText);
		Homey.ManagerSettings.set('sendLog', "");
	}

	async sendLog() {
		let tries = 5;

		while (tries-- > 0) {
			try {
				Homey.app.updateLog("Sending log");
				// create reusable transporter object using the default SMTP transport
				let transporter = nodemailer.createTransport({
					host: Homey.env.MAIL_HOST, //Homey.env.MAIL_HOST,
					port: 25,
					ignoreTLS: true,
					secure: false, // true for 465, false for other ports
					auth: {
						user: Homey.env.MAIL_USER, // generated ethereal user
						pass: Homey.env.MAIL_SECRET // generated ethereal password
					},
					tls: {
						// do not fail on invalid certs
						rejectUnauthorized: false
					}
				});

				// send mail with defined transport object
				let info = await transporter.sendMail({
					from: '"Homey User" <' + Homey.env.MAIL_USER + '>', // sender address
					to: Homey.env.MAIL_RECIPIENT, // list of receivers
					subject: "ONVIF log", // Subject line
					text: Homey.ManagerSettings.get('diagLog') // plain text body
				});

				Homey.app.updateLog("Message sent: " + info.messageId);
				// Message sent: <b658f8ca-6296-ccf4-8306-87d57a0b4321@example.com>

				// Preview only available when sending through an Ethereal account
				console.log("Preview URL: ", nodemailer.getTestMessageUrl(info));
				return "";
			} catch (err) {
				Homey.app.updateLog("Send log error: " + err.stack);
			};
		}
		Homey.app.updateLog("Send log FAILED");
	}
}

module.exports = MyApp;