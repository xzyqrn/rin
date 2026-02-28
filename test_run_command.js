const { buildTools } = require('./src/tools');

try {
    const tools = buildTools({}, 12345, { admin: true });
    console.log('Tools built successfully for admin. Keys:', tools.definitions.map(d => d.function.name));

    const exec = tools.executor;
    exec('run_command', { command: 'echo hello' }).then(res => {
        console.log('run_command result:', res);
    }).catch(err => {
        console.error('run_command failed:', err);
    });
} catch (e) {
    console.error("Error building tools:", e);
}
