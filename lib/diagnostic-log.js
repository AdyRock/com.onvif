'use strict';

function maskSensitiveText(text, password = null)
{
	if (typeof text !== 'string')
	{
		return text;
	}

	text = text.replace(/\/\/([^:@/\s]+):([^@/\s]+)@/g, '//$1:YOUR_PASSWORD@');
	text = text.replace(/([?&](?:password|pass|pwd)=)[^&\s"']+/gi, '$1YOUR_PASSWORD');

	if (password)
	{
		text = text.split(password).join('YOUR_PASSWORD');
		const encoded = encodeURIComponent(password);
		if (encoded !== password)
		{
			text = text.split(encoded).join('YOUR_PASSWORD');
		}
	}

	return text;
}

module.exports = {
	maskSensitiveText
};
