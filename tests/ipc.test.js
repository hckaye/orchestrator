import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  removeWorkerSock,
  workerSock,
  workerSockUsesFilesystem,
} from "../orchestrator/lib/state.js";
import {
  workerSock as desktopWorkerSock,
  workerSockUsesFilesystem as desktopWorkerSockUsesFilesystem,
} from "../desktop/electron/lib/paths.js";
import { pingWorker } from "../desktop/electron/lib/actions.js";

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("CLI and Desktop use platform-correct worker IPC endpoints", () => {
  const id = "devin-20260812000000-test";
  const workersDir = path.join(os.tmpdir(), "orchestrator-ipc-fixture");
  const windows = String.raw`\\.\pipe\orchestrator-${id}`;
  const posix = path.join(workersDir, `${id}.sock`);

  assert.equal(workerSock(id, { platform: "win32", workersDir }), windows);
  assert.equal(desktopWorkerSock(id, { platform: "win32", workersDir }), windows);
  assert.equal(workerSock(id, { platform: "linux", workersDir }), posix);
  assert.equal(desktopWorkerSock(id, { platform: "darwin", workersDir }), posix);
  assert.equal(workerSockUsesFilesystem({ platform: "win32" }), false);
  assert.equal(desktopWorkerSockUsesFilesystem({ platform: "win32" }), false);
  assert.equal(workerSockUsesFilesystem({ platform: "linux" }), true);
  assert.equal(desktopWorkerSockUsesFilesystem({ platform: "darwin" }), true);
});

test("current-platform worker endpoint supports an IPC round trip", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-ipc-"));
  const id = `ipc-${process.pid}-${Date.now()}`;
  const options = { workersDir: temp };
  const endpoint = workerSock(id, options);
  const server = net.createServer((connection) => {
    connection.end("pong\n");
  });

  try {
    removeWorkerSock(id, options);
    await listen(server, endpoint);
    const reply = await new Promise((resolve, reject) => {
      let data = "";
      const client = net.connect(endpoint);
      client.setEncoding("utf8");
      client.on("data", (chunk) => { data += chunk; });
      client.on("end", () => resolve(data));
      client.on("error", reject);
    });
    assert.equal(reply, "pong\n");
  } finally {
    if (server.listening) await close(server);
    removeWorkerSock(id, options);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("Desktop ping connects to a Windows named pipe without a filesystem probe", {
  skip: process.platform !== "win32",
}, async () => {
  const id = `ipc-desktop-${process.pid}-${Date.now()}`;
  const endpoint = desktopWorkerSock(id);
  const server = net.createServer((connection) => {
    let input = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      input += chunk;
      if (!input.includes("\n")) return;
      const request = JSON.parse(input.trim());
      connection.end(`${JSON.stringify({ ok: request.cmd === "ping" })}\n`);
    });
  });

  try {
    await listen(server, endpoint);
    assert.deepEqual(await pingWorker(id), { ok: true });
  } finally {
    if (server.listening) await close(server);
  }
});
