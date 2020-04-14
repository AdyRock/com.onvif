/**
 * Created by Andrew D.Laptev<a.d.laptev@gmail.com> on 14.03.17.
 */

const http = require('http')
	, dgram = require('dgram')
	, fs = require('fs')
	, Buffer = require('buffer').Buffer
	, template = require('dot').template
	, reBody = /<s:Body xmlns:xsi="http:\/\/www.w3.org\/2001\/XMLSchema-instance" xmlns:xsd="http:\/\/www.w3.org\/2001\/XMLSchema">(.*)<\/s:Body>/
	, reCommand = /<(\S*) /
	, reNS = /xmlns="http:\/\/www.onvif.org\/\S*\/(\S*)\/wsdl"/
	, __xmldir = __dirname + '/serverMockup/'
	, conf = {
		port: process.env.PORT || 10101 // server port
		,  hostname: process.env.HOSTNAME || 'localhost'
		, pullPointUrl: '/onvif/subscription?Idx=6'
	}
	;

const listener = (req, res) => {
	req.setEncoding('utf8');
	const buf = [];
	req.on('data', chunk => buf.push(chunk));
	req.on('end', () => {
		let request;
		if (Buffer.isBuffer(buf)) {// Node.js > 0.12 fix when `data` event produces strings instead of Buffer
			request = Buffer.concat(buf);
		} else {
			request = buf.join('');
		}
		// Find body and command name
		let body = reBody.exec(request);
		if (!body) {
			return res.end();
		}
		body = body[1];
		let command = reCommand.exec(body)[1];
		const ns = reNS.exec(body)[1];
		if (!command) {
			return res.end();
		}
		if (fs.existsSync(__xmldir + ns + '.' + command + '.xml')) {
			command = ns + '.' + command;
		}
		if (!fs.existsSync(__xmldir + command + '.xml')) {
			command = 'Error';
		}
		const fileName = __xmldir + command + '.xml';
		// console.log('serving', fileName);
		// fs.createReadStream(__dirname + '/serverMockup/' + command + '.xml').pipe(res);
		res.end(template(fs.readFileSync(fileName))(conf))
	});
};



# Discovery service
		discover = dgram.createSocket('udp4')
		discover.msg =
			new Buffer(fs
				.readFileSync __xmldir + 'Probe.xml'
			.toString()
			.replace 'SERVICE_URI', 'http://localhost:' + (process.env.PORT || 10101) + '/onvif/device_service'
	)
		discover.on 'error', (err) -> throw err
		discover.on 'message', (msg, rinfo) ->
		msgId = /urn:uuid:([0-9a-f\-]+)</.exec(msg.toString())[1]
		if msgId
			switch msgId
				# Wrong message test
					when 'e7707' then discover.send (new Buffer 'lollipop'), 0, 8, rinfo.port, rinfo.address
      # Double sending test
					when 'd0-61e'
					discover.send discover.msg, 0, discover.msg.length, rinfo.port, rinfo.address
					discover.send discover.msg, 0, discover.msg.length, rinfo.port, rinfo.address
      # Discovery test
				else
					discover.send discover.msg, 0, discover.msg.length, rinfo.port, rinfo.address

					discover.bind 3702, () ->
				discover.addMembership '239.255.255.250'

					server = http
						.createServer listener
					.listen conf.port

					module.exports = {
						server: server
						, conf: conf
					}
