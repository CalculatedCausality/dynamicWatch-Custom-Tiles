// The public lightpollutionmap.info viewer adds base64(epoch-seconds + "." +
// MD5 of its published client identifier) to /tiles/wms requests. The hash
// is static and public; generate a fresh timestamp for each request because
// the endpoint rejects stale tokens.
const PUBLIC_CLIENT_HASH = "971c8ccc11150435bc555a975751b909";

export function lightPollutionToken(now = Date.now()) {
	return btoa(`${Math.floor(now / 1000)}.${PUBLIC_CLIENT_HASH}`);
}
