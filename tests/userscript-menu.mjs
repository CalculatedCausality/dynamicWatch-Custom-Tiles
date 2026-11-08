import test from 'node:test';
import assert from 'node:assert/strict';
import { CFG } from '../src/config.js';
import {
	redact, buildDiagnostics, createLogBuffer, captureUserscriptLogs,
	registerUserscriptMenu, LOCAL_PREFERENCE_KEYS, GM_PREFERENCE_DEFAULTS,
} from '../src/ui/userscript-menu.js';

test('redaction removes sensitive patterns but retains useful error context', () => {
	const cases = [
		['request https://api.example.com/tiles?token=secret#position refused', 'https://api.example.com/tiles', ['secret', 'position']],
		['JWT eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjE5OTk5OTk5OTl9.signature failed', 'failed', ['eyJ', 'signature']],
		['email person@example.com refused', 'refused', ['person@example.com']],
		['hex 0123456789abcdef01234567 failed', 'hex', ['0123456789abcdef01234567']],
		['base64 YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo= failed', 'base64', ['YWJjZGVm']],
		['map -27.123456, 153.456789 unavailable', 'unavailable', ['27.123456', '153.456789']],
		['map lat=-27.12 lng=153.45 unavailable', 'unavailable', ['27.12', '153.45']],
		['plan 123/SP456789 unavailable planId=private-id', 'unavailable', ['SP456789', 'private-id']],
		['password=secret username=somebody cookie=private token=abc', '[private]', ['secret', 'somebody', 'private token', 'abc']],
		['request https://example.com/routes/12345 failed', 'failed', ['12345']],
		['tile https://example.com/12/1234/5678.png failed', 'failed', ['1234', '5678']],
	];
	for (const [input, keep, remove] of cases) {
		const result = redact(input);
		assert.ok(result.includes(keep), result);
		for (const secret of remove) assert.ok(!result.includes(secret), `${secret}: ${result}`);
	}
	assert.equal(redact('[CustomTiles] Vexcel HTTP 403; retry in 15s'), '[CustomTiles] Vexcel HTTP 403; retry in 15s');
});

test('diagnostics explicitly allowlists fields and reports boolean health only', () => {
	const report = buildDiagnostics({
		version: '2.0', manager: 'Tampermonkey 5', userAgent: 'Test Browser',
		base: 'Vexcel Aerial', overlays: ['QLD Labels'], mode3D: true,
		token: 'DO_NOT_PRINT', password: 'DO_NOT_PRINT', cookies: 'DO_NOT_PRINT',
		health: { qldValid: true, appleValid: false, vexcelValid: true,
			loginStored: true, loginRejected: false, token: 'DO_NOT_PRINT' },
		logs: ['[CustomTiles] request https://example.com/api?secret=DO_NOT_PRINT'],
	});
	assert.match(report, /version: 2.0/);
	assert.match(report, /Active base: Vexcel Aerial/);
	assert.match(report, /Active overlays: QLD Labels/);
	for (const line of ['qldValid: true', 'appleValid: false', 'vexcelValid: true',
		'loginStored: true', 'loginRejected: false', '3D mode: true']) assert.ok(report.includes(line));
	assert.ok(!report.includes('DO_NOT_PRINT'));
});

function fixture(hostname = 'dynamic.watch') {
	const commands = new Map();
	const store = new Map();
	const local = new Map();
	const writes = [];
	const answers = [];
	const alerts = [];
	let reloads = 0;
	const gm = {
		GM_registerMenuCommand: (label, cb) => commands.set(label, cb),
		GM_getValue: (key, fallback) => store.has(key) ? store.get(key) : fallback,
		GM_setValue: (key, value) => { writes.push(key); store.set(key, value); },
	};
	const win = {
		location: { hostname, reload() { reloads++; } },
		console: { warn() {}, error() {} },
		confirm: () => answers.shift() ?? false,
		alert: (message) => alerts.push(message),
		localStorage: { removeItem: (key) => local.delete(key) },
	};
	registerUserscriptMenu({ app: {}, gm, win });
	return { commands, store, local, writes, answers, alerts, get reloads() { return reloads; } };
}

test('registers exactly four commands on dynamic.watch, none on Waze or other hosts', () => {
	assert.deepEqual([...fixture().commands.keys()], [
		'Vexcel: change login…', 'Vexcel: sign out on this device',
		'Reset layer & panel preferences', 'Diagnostics / report a problem',
	]);
	assert.equal(fixture('embed.waze.com').commands.size, 0);
	assert.equal(fixture('dynamic.watch.evil.example').commands.size, 0);
	assert.equal(fixture('www.dynamic.watch').commands.size, 4);
});

test('change login explains a failed login but stays quiet when cancelled', () => {
	const f = fixture();
	const replies = [null, 'not a token'];
	globalThis.window = { prompt: () => replies.shift() };
	try {
		const change = f.commands.get('Vexcel: change login…');
		change();
		assert.deepEqual(f.alerts, [], 'cancelled prompt');
		change();
		assert.equal(f.alerts.length, 1);
		assert.match(f.alerts[0], /isn't a valid Vexcel token/);
	} finally { delete globalThis.window; }
});

test('sign-out is confirmed and clears exactly the five Vexcel storage keys', () => {
	const f = fixture();
	const keys = [CFG.VEXCEL_USER_KEY, CFG.VEXCEL_PASS_KEY, CFG.VEXCEL_TOKEN_KEY,
		CFG.VEXCEL_SESSION_KEY, CFG.VEXCEL_REJECTED_KEY];
	for (const key of keys) f.store.set(key, 'secret');
	f.store.set('qld_token', 'preserved');
	const signout = f.commands.get('Vexcel: sign out on this device');
	signout();
	assert.equal(f.writes.length, 0);
	f.answers.push(true);
	signout();
	assert.deepEqual(f.writes, keys);
	for (const key of keys.slice(0, 4)) assert.equal(f.store.get(key), '');
	assert.equal(f.store.get(CFG.VEXCEL_REJECTED_KEY), false);
	assert.equal(f.store.get('qld_token'), 'preserved');
});

test('reset clears only script preferences, preserves credentials and offers reload', () => {
	const f = fixture();
	for (const key of LOCAL_PREFERENCE_KEYS) f.local.set(key, 'saved');
	f.local.set('dynamicWatchData', 'preserved');
	f.store.set(CFG.VEXCEL_PASS_KEY, 'preserved');
	f.store.set(CFG.VEXCEL_TOKEN_KEY, 'preserved');
	const reset = f.commands.get('Reset layer & panel preferences');
	reset();
	assert.equal(f.writes.length, 0);
	assert.equal(f.local.size, 3);
	f.answers.push(true, false);
	reset();
	assert.deepEqual(f.writes, Object.keys(GM_PREFERENCE_DEFAULTS));
	for (const [key, value] of Object.entries(GM_PREFERENCE_DEFAULTS)) assert.equal(f.store.get(key), value);
	assert.deepEqual([...f.local], [['dynamicWatchData', 'preserved']]);
	assert.equal(f.store.get(CFG.VEXCEL_PASS_KEY), 'preserved');
	assert.equal(f.store.get(CFG.VEXCEL_TOKEN_KEY), 'preserved');
	assert.equal(f.reloads, 0);
	f.answers.push(true, true);
	reset();
	assert.equal(f.reloads, 1);
});

test('log buffer stores only the last 20 matching messages, redacted before storage', () => {
	const buffer = createLogBuffer();
	buffer.add('warn', ['other [CustomTiles] message']);
	for (let i = 0; i < 25; i++) buffer.add('error', [`[CustomTiles] failure ${i}`, { password: 'secret' }]);
	const messages = buffer.read();
	assert.equal(messages.length, 20);
	assert.match(messages[0], /failure 5/);
	assert.match(messages[19], /failure 24/);
	assert.ok(!messages.join('').includes('secret'));
	messages.pop();
	assert.equal(buffer.read().length, 20);
	buffer.add('warn', ['[CustomTiles] email person@example.com']);
	assert.ok(!buffer.read().join('').includes('person@example.com'));
});

test('console wraps once and passes through original arguments, receiver and result', () => {
	const calls = [];
	const target = {
		warn(...args) { calls.push([this, 'warn', args]); return 42; },
		error(...args) { calls.push([this, 'error', args]); return 43; },
	};
	const buffer = captureUserscriptLogs(target);
	const wrapped = target.warn;
	assert.equal(captureUserscriptLogs(target), buffer);
	assert.equal(target.warn, wrapped);
	const obj = { password: 'secret' };
	assert.equal(target.warn('[CustomTiles] warning', obj), 42);
	assert.equal(target.error('unrelated'), 43);
	assert.equal(calls.length, 2);
	assert.equal(calls[0][0], target);
	assert.equal(calls[0][2][1], obj);
	assert.equal(buffer.read().length, 1);
});
