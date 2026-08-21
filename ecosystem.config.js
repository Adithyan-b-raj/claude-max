module.exports = {
  apps: [{
    name: 'opusmax-proxy',
    script: 'src/index.js',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 10,
    min_uptime: '10s',
    listen_timeout: 8000,
    kill_timeout: 5000,
    env: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
    error_file: '/var/log/opusmax/error.log',
    out_file: '/var/log/opusmax/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
  }],
};
