// 릴스 게임(몸무게 전쟁 사무실·단풍숲, 야구장)을 이 서버 안에서 같이 돌린다: Render 무료 시간을 서버 하나로 아끼려고.
// 각 게임은 자기 server.js 그대로 내부 포트에서 자식 프로세스로 뜨고, /g/<이름>/... 요청을 그 포트로 넘긴다.
// 게임 화면은 '/state' 같은 절대 경로를 쓰므로, HTML을 넘길 때 fetch 와 '/'로 시작하는 링크에 /g/<이름> 을 붙이는 작은 스크립트를 끼운다.
// 게임 원본은 ~/plaza, ~/forest, ~/baseball 이고, 고치면 repo 의 games/<이름>/ 로 복사해서 push 한다.
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const GAMES = { office: 9101, forest: 9102, baseball: 9103 };
const ROOT = path.join(__dirname, '..', 'games');

function start(name, port) {
  const child = spawn(process.execPath, [path.join(ROOT, name, 'server.js')], {
    cwd: path.join(ROOT, name), env: { ...process.env, PORT: String(port) }, stdio: 'inherit',
  });
  child.on('exit', code => { console.error(`[games] ${name} 종료(${code}), 3초 뒤 다시 켬`); setTimeout(() => start(name, port), 3000); });
}

const shim = base => `<script>(()=>{const B=${JSON.stringify(base)},f=window.fetch.bind(window);` +
  `window.fetch=(u,o)=>f(typeof u==='string'&&u[0]==='/'&&u[1]!=='/'?B+u:u,o);` +
  `document.addEventListener('click',e=>{const a=e.target.closest&&e.target.closest('a[href^="/"]');` +
  `if(a&&!a.getAttribute('href').startsWith(B))a.setAttribute('href',B+a.getAttribute('href'))},true)})()</script>`;

function proxy(name, port) {
  const base = '/g/' + name;
  return (req, res) => {
    if (req.originalUrl === base) return res.redirect(301, base + '/'); // 상대 경로(map.js)가 맞게 풀리도록
    const up = http.request({ host: '127.0.0.1', port, method: req.method, path: req.url, headers: { ...req.headers, host: '127.0.0.1:' + port } }, r => {
      const html = /text\/html/.test(r.headers['content-type'] || '');
      if (!html) { res.writeHead(r.statusCode, r.headers); return r.pipe(res); }
      const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const out = /<head[^>]*>/i.test(body) ? body.replace(/<head[^>]*>/i, m => m + shim(base)) : shim(base) + body;
        const h = { ...r.headers }; delete h['content-length'];
        res.writeHead(r.statusCode, h); res.end(out);
      });
    });
    up.on('error', () => { if (!res.headersSent) res.status(502).send('게임 서버를 켜는 중이에요. 잠시 뒤 새로고침해 주세요.'); });
    req.pipe(up);
  };
}

module.exports = app => {
  for (const [name, port] of Object.entries(GAMES)) { start(name, port); app.use('/g/' + name, proxy(name, port)); }
};
