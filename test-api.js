const OpenAI = require('./node_modules/openai');
require('./node_modules/dotenv').config({ path: './.env' });
const { buildTools } = require('./src/tools');

const openai = new OpenAI({
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKey: process.env.GEMINI_API_KEY,
});

async function main() {
    const payload = require('/tmp/llm_payload.json');
    const tools = buildTools({}, 1, { admin: true });

    try {
        const res = await openai.chat.completions.create({
            model: payload.model,
            messages: payload.messages,
            tools: tools.definitions,
            tool_choice: 'auto',
            signal: new AbortController().signal,
        });
        console.log(res.choices[0].message);
    } catch (err) {
        if (err.response) {
            console.error('API Error Status:', err.status);
            console.error('API Error Response:', JSON.stringify(err.response.data || err.response, null, 2));
        } else {
            console.error('Error:', err);
        }
    }
}
main();
