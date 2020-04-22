'use strict';

const Homey = require('homey');
var onvif = require('onvif');
let Cam = require('onvif').Cam;
var path = require('path');

class MyApp extends Homey.App {

	onInit() {
		this.log('MyApp is running...');
		this.discoveredDevices = [];
		this.discoveryInitialised = false;
		Homey.ManagerSettings.set('diagLog', "App Started");
	}

	async discoverCameras() {
		this.discoveredDevices = [];
		Homey.app.updateLog('====  Discovery Starting  ====');
		if (!this.discoveryInitialised) {
			this.discoveryInitialised = true;
			onvif.Discovery.on('device', function (cam, rinfo, xml) {
				try {
					// function will be called as soon as NVT responds
					Homey.app.updateLog('Reply from ' + JSON.stringify(cam, null, 2));

					var data = {};
					data = {
						"id": cam.hostname,
						"port": cam.port,
					};
					this.discoveredDevices.push({
						"name": cam.hostname,
						data,
						settings: {
							// Store username & password in settings
							// so the user can change them later
							"username": "",
							"password": "",
						}
					})
				} catch (err) {
					Homey.app.updateLog("Discovery error: " + JSON.stringify(err, null, 2), true);
				}
			}.bind(this))

			onvif.Discovery.on('error', function (msg, xml) {
				Homey.app.updateLog("Discovery error: " + JSON.stringify(msg, null, 2), true);
				if (xml) {
					Homey.app.updateLog("xml: " + JSON.stringify(xml, null, 2));
				}
			}.bind(this))
		}

		// Start the discovery process running
		onvif.Discovery.probe({'resolve': false});

		// Allow time for the process to finish
		await new Promise(resolve => setTimeout(resolve, 5000));
		Homey.app.updateLog('====  Discovery Finished  ====');
		let devices = this.discoveredDevices;
		this.discoveredDevices = [];
		return devices;
	}

	async connectCamera(hostName, port, username, password) {
		return new Promise(function (resolve, reject) {
			try {
				Homey.app.updateLog("--------------------------");
				Homey.app.updateLog('Connect to Camera ' + hostName + ':' + port + " - " + username);

				let cam = new Cam({
					hostname: hostName,
					username: username,
					password: password,
					port: port,
					timeout: 5000,
				}, function (err) {
					if (err) {
						Homey.app.updateLog('Connection Failed for ' + hostName + ' Port: ' + port + ' Username: ' + username, true);
						reject(err);
					} else {
						Homey.app.updateLog('CONNECTED');
						resolve(cam);
					}
				});
			} catch (err) {
				reject(err);
			}
		});
	}

	async getDateAndTime(cam_obj) {
		return new Promise(function (resolve, reject) {
			try {
				cam_obj.getSystemDateAndTime(function (err, date, xml) {
					if (err) {
						reject(err);
					} else {
						resolve(date);
					}
				});
			} catch (err) {
				reject(err);
			}
		});
	}

	async getDeviceInformation(cam_obj) {
		return new Promise(function (resolve, reject) {
			try {
				cam_obj.getDeviceInformation(function (err, info, xml) {
					if (err) {
						reject(err);
					} else {
						resolve(info);
					}
				});
			} catch (err) {
				reject(err);
			}
		});
	}

	async getCapabilities(cam_obj) {
		return new Promise(function (resolve, reject) {
			try {
				cam_obj.getCapabilities(function (err, info, xml) {
					if (err) {
						reject(err);
					} else {
						resolve(info);
					}
				});
			} catch (err) {
				reject(err);
			}
		});
	}

	async getSnapshotURL(cam_obj) {
		return new Promise(function (resolve, reject) {
			try {
				cam_obj.getSnapshotUri(function (err, info, xml) {
					if (err) {
						reject(err);
					} else {
						resolve(info);
					}
				});
			} catch (err) {
				reject(err);
			}
		});
	}

	async hasEventTopics(cam_obj) {
		return new Promise(function (resolve, reject) {
			try {
				let supportedEvents = [];
				cam_obj.getEventProperties(function (err, data, xml) {
					if (err) {
						reject(err);
					} else {
						// Display the available Topics
						let parseNode = function (node, topicPath, nodeName) {
							// loop over all the child nodes in this node
							for (const child in node) {
								if (child == "$") {
									continue;
								} else if (child == "messageDescription") {
									// we have found the details that go with an event
									supportedEvents.push(nodeName.toUpperCase());
									Homey.app.updateLog('Found Event - ' + nodeName)
									return;
								} else {
									// descend into the child node, looking for the messageDescription
									parseNode(node[child], topicPath + '/' + child, child)
								}
							}
						}
						parseNode(data.topicSet, '', '')
					}
					resolve(supportedEvents);
				});
			} catch (err) {
				reject(err);
			}
		});
	}

	hasPullSupport(capabilities) {
		if (capabilities.events && capabilities.events.WSPullPointSupport && capabilities.events.WSPullPointSupport == true) {
			Homey.app.updateLog('Camera supports WSPullPoint');
			return true;
		}

		Homey.app.updateLog('This camera/NVT does not support PullPoint Events', true);
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

	updateLog(newMessage, ignoreSetting) {
		if (!ignoreSetting && !Homey.ManagerSettings.get('logEnabled')) {
			return;
		}

		this.log(newMessage);
		var oldText = Homey.ManagerSettings.get('diagLog');
		if (oldText.length > 5000) {
			oldText = "";
		}
		oldText += "* ";
		oldText += newMessage;
		oldText += "\r\n";
		Homey.ManagerSettings.set('diagLog', oldText);
	}
}

module.exports = MyApp;