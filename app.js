'use strict';

const Homey = require('homey');
var onvif = require('onvif');
let Cam = require('onvif').Cam;
var path = require('path');

class MyApp extends Homey.App {

	onInit() {
		this.log('MyApp is running...');
	}

	async discoverCameras() {
		const devices = [];
		onvif.Discovery.on('device', async function (cam, rinfo, xml) {
			// function will be called as soon as NVT responds
			console.log('Reply from ', rinfo.address);

			let info = await Homey.app.getDeviceInformation(cam);
			console.log(info);

			let supportedEvents = [];
			let capabilities = await Homey.app.getCapabilities(cam);
			let hasEvents = Homey.app.hasPullSupport(capabilities);
			if (hasEvents) {
				supportedEvents = await Homey.app.hasEventTopics(cam);
			}
			console.log("Supported Events: ", supportedEvents);

			var data = {};
			data = {
				"id": cam.hostname,
				"port": cam.port,
				"path": cam.path,
				"manufacturer": info.manufacturer,
				"model": info.model,
				"serialNumber": info.serialNumber,
				"firmwareVersion": info.firmwareVersion,
				"hasMotion": (supportedEvents.indexOf('MOTION') >= 0)
			};
			devices.push({
				"name": cam.hostname,
				data,
				settings: {
					// Store username & password in settings
					// so the user can change them later
					"username": "",
					"password": "",
				}

			})

		})

		onvif.Discovery.probe();
		await new Promise(resolve => setTimeout(resolve, 5000));
		return devices;
	}

	async connectCamera(hostName, port, username, password) {
		return new Promise(function (resolve, reject) {
			try {
				console.log("----------------------------------------------------------------");
				console.log('Connect to Camera ', hostName, ':', port, " - ", username);

				let cam = new Cam({
					hostname: hostName,
					username: username,
					password: password,
					port: port,
					timeout: 10000,
					preserveAddress: true // Enables NAT support and re-writes for PullPointSubscription URL
				}, function (err) {
					if (err) {
						console.log('Connection Failed for ' + hostName + ' Port: ' + port + ' Username: ' + username);
						reject(err);
					} else {
						console.log('CONNECTED');
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
									console.log('Found Event - ' + nodeName)
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
			console.log('Camera supports WSPullPoint');
			return true;
		}

		console.log('This camera/NVT does not support PullPoint Events');
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

	getUserDataPath( filename )
	{
		return path.join(__dirname, 'userdata', filename);
	}
}

module.exports = MyApp;