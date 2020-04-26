'use strict';

const Homey = require('homey');

class CameraDriver extends Homey.Driver {

	onInit() {
		this.log('CameraDriver has been inited');
		this.lastUsername = '';
		this.lastPassword = '';
		this.lastHostName = '';
		this.lastPort = 0;

		this.motionCondition = new Homey.FlowCardCondition('motionEnabledCondition');
		this.motionCondition
			.register()
			.registerRunListener(async (args, state) => {

				return await args.device.getCapabilityValue('motion_enabled'); // Promise<boolean>
			});

		this.motionEnabledAction = new Homey.FlowCardAction('motionEnableAction');
		this.motionEnabledAction
			.register()
			.registerRunListener(async (args, state) => {

				args.device.onCapabilityMotionEnable(true, null);
				return await args.device.setCapabilityValue('motion_enabled', true); // Promise<void>
			})

		this.motionDisabledAction = new Homey.FlowCardAction('motionDisableAction');
		this.motionDisabledAction
			.register()
			.registerRunListener(async (args, state) => {

				args.device.onCapabilityMotionEnable(false, null);
				return await args.device.setCapabilityValue('motion_enabled', false); // Promise<void>
			})

		this.snapshotAction = new Homey.FlowCardAction('snapshotAction');
		this.snapshotAction
			.register()
			.registerRunListener(async (args, state) => {

				let err = await args.device.nowImage.update();
				if (!err) {
					let tokens = {
						'image': args.device.nowImage
					}

					args.device.snapshotReadyTrigger
						.trigger(args.device, tokens)
						.catch(args.device.error)
						.then(args.device.log("Snapshot ready"))
				}
				return err;
			})
	}

	async getLastCredentials(device) {
		await device.setSettings({
			'username': this.lastUsername,
			'password': this.lastPassword
		});
		await device.setStoreValue('initialised', true);
		Homey.app.updateLog("Saved Credentials");
	}

	onPair(socket) {
		socket.on('list_devices', (data, callback) => {
			Homey.app.discoverCameras().then(devices => {
				Homey.app.updateLog("Discovered: " + Homey.app.varToString(devices, null, 2));
				callback(null, devices);
			}).catch(function (err) {
				callback(new Error("Connection Failed" + err), []);
			});
		});

		socket.on('list_devices_selection', (data, callback) => {
			// User selected a device so cache the information required to validate it when the credentials are set
			console.log("list_devices_selection: ", data);
			this.lastHostName = data[0].settings.ip;
			this.lastPort = data[0].settings.port;
			callback();
		});

		socket.on('login', (data, callback) => {
			this.lastUsername = data.username;
			this.lastPassword = data.password;

			Homey.app.updateLog("Testing connection credentials");

			Homey.app.connectCamera(
					this.lastHostName,
					this.lastPort,
					this.lastUsername,
					this.lastPassword
				)
				.then(cam => {
					Homey.app.updateLog("Valid");
					callback(null, true);
				})
				.catch(err => {
					Homey.app.updateLog("Failed: " + Homey.app.varToString(err), true);
					callback(err);
				});
		});
	}

	async onRepair(socket, device) {
		// Argument socket is an EventEmitter, similar to Driver.onPair
		// Argument device is a Homey.Device that's being repaired

		device.repairing = true;

		socket.on('login', async (data, callback) => {
			await device.setSettings({
				'username': data.username,
				'password': data.password
			});

			let settings = device.getSettings();
			let devices = await Homey.app.discoverCameras();

			console.log("Discovered devices: ", devices);

			devices.forEach(async function (discoveredDevice) {
				try {
					let cam = await Homey.app.connectCamera(
						discoveredDevice.settings.ip,
						discoveredDevice.settings.port,
						settings.username,
						settings.password
					);

					let info = {};
					try {
						info = await Homey.app.getDeviceInformation(cam);
						Homey.app.updateLog("Camera Information: " + Homey.app.varToString(info));
					} catch (err) {
						Homey.app.updateLog("Get camera info error: " + err.stack, true);
						return;
					}

					if ((info.serialNumber === settings.serialNumber) && (info.model === settings.model)) {
						// found it
						await device.setSettings({
							'ip': discoveredDevice.settings.ip,
							'port': discoveredDevice.settings.port
						});
						device.cam = cam;
						device.setupImages()

						Homey.app.updateLog("Found the camera: " + Homey.app.varToString(info));
					}

				} catch (err) {
					Homey.app.updateLog("Get camera info error: " + err.stack, true);
				}
			});
			callback(null, true);
		});

		socket.on('disconnect', () => {
			// Cleanup
			device.repairing = false;
		})

	}
}

module.exports = CameraDriver;