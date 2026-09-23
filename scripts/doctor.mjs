import {spawnSync} from 'node:child_process';

const major = Number(process.versions.node.split('.')[0]);
const configured = Boolean(process.env.YUXI_LIBRARY_UPSTREAM?.trim());
const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
  encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
});
const result = {
  node: process.versions.node,
  platform: `${process.platform}/${process.arch}`,
  libraryUiCanStart: major >= 24,
  upstreamConfigured: configured,
  dockerCommandAvailable: docker.error?.code !== 'ENOENT',
  dockerDaemonReady: docker.status === 0,
  realYuxiAcceptance: 'NOT_RUN',
  note: 'Docker is unnecessary for this independent connector when an existing Yuxi server is supplied. The official local Yuxi backend has separate deployment dependencies.',
};
console.log(JSON.stringify(result, null, 2));
if (major < 24) process.exitCode = 1;
else if (!configured) process.exitCode = 2;
