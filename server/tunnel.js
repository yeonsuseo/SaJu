const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let tunnelProcess = null;
let currentTunnelUrl = null;

function findCloudflaredBin() {
  const localAppPath = path.join(process.env.USERPROFILE || 'C:\\Users\\user', '.local', 'bin', 'cloudflared.exe');
  if (fs.existsSync(localAppPath)) {
    return localAppPath;
  }
  return 'cloudflared';
}

function startTunnel(port = 4567) {
  const bin = findCloudflaredBin();
  console.log(`\n☁️  Cloudflare 터널 연결 시도 중... (${bin})`);

  try {
    tunnelProcess = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const checkOutput = (data) => {
      const text = data.toString();
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match && !currentTunnelUrl) {
        currentTunnelUrl = match[0];
        console.log(`\n===============================================================`);
        console.log(`🎉 외부 친구 공유용 링크가 준비되었습니다!`);
        console.log(`   👉 ${currentTunnelUrl}`);
        console.log(`   (카톡, 인스타 등으로 이 링크를 보내면 외부에서도 접속됩니다!)`);
        console.log(`===============================================================\n`);
      }
    };

    tunnelProcess.stdout.on('data', checkOutput);
    tunnelProcess.stderr.on('data', checkOutput);

    tunnelProcess.on('close', (code) => {
      console.log(`[Cloudflare] 터널 프로세스 종료됨 (코드: ${code})`);
      currentTunnelUrl = null;
    });

    tunnelProcess.on('error', (err) => {
      console.warn(`[Cloudflare] 터널 실행 실패: ${err.message}`);
    });

  } catch (err) {
    console.warn(`[Cloudflare] 터널 시작 예외: ${err.message}`);
  }

  // 프로세스 종료 시 터널도 함께 종료
  process.on('exit', stopTunnel);
  process.on('SIGINT', () => { stopTunnel(); process.exit(); });
  process.on('SIGTERM', () => { stopTunnel(); process.exit(); });
}

function stopTunnel() {
  if (tunnelProcess) {
    try {
      tunnelProcess.kill();
    } catch (e) {}
    tunnelProcess = null;
    currentTunnelUrl = null;
  }
}

function getTunnelUrl() {
  return currentTunnelUrl;
}

module.exports = { startTunnel, stopTunnel, getTunnelUrl };
