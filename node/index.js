const express = require('express');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
const port = process.env.WHISPER_PORT || 8801;

app.use(express.json());

// --- Configuration ---
// Path to the C++ whisper executable, relative to the root of the project.
const whisperExecutablePath = path.resolve(__dirname, '..', 'whisper');
// Arguments for the whisper executable to run in service mode.
// Add any other necessary model paths etc. here.
const whisperArgs = [
    // Add arguments like '--encoder', './models/small-encoder.axmodel' if they are not in the default location.
];
// --- End Configuration ---

let whisperProcess = null;
let isBusy = false;
let stdoutBuffer = '';

function startWhisperProcess() {
    console.log('Starting whisper C++ service...');
    
    // Spawn the C++ process
    whisperProcess = spawn(whisperExecutablePath, whisperArgs, {
        cwd: path.resolve(__dirname, '..') // Run from the root of the C++ project
    });

    // Handle stdout
    whisperProcess.stdout.on('data', (data) => {
        const text = data.toString();
        console.log(`[Whisper STDOUT]: ${text}`);
        stdoutBuffer += text;
    });

    // Handle stderr
    whisperProcess.stderr.on('data', (data) => {
        console.error(`[Whisper STDERR]: ${data.toString()}`);
    });

    // Handle process exit
    whisperProcess.on('close', (code) => {
        console.log(`Whisper C++ service exited with code ${code}. Restarting...`);
        whisperProcess = null;
        // Optional: Implement a more robust restart mechanism if needed
        setTimeout(startWhisperProcess, 1000); 
    });

    whisperProcess.on('error', (err) => {
        console.error('Failed to start whisper C++ service.', err);
    });

    console.log('Whisper C++ service started.');
}

app.post('/recognize', (req, res) => {
    const { filePath } = req.body;

    if (!filePath) {
        return res.status(400).json({ error: 'Missing "filePath" in request body.' });
    }

    if (!whisperProcess || whisperProcess.killed) {
        return res.status(503).json({ error: 'Whisper service is not running.' });
    }

    if (isBusy) {
        return res.status(429).json({ error: 'Service is busy. Please try again later.' });
    }

    isBusy = true;
    stdoutBuffer = ''; // Clear buffer before new request

    console.log(`Sending path to whisper service: ${filePath}`);

    // Create a one-time listener to capture the specific result
    const resultListener = (data) => {
        const text = data.toString();
        // A simple way to detect the end of a result.
        // This assumes the C++ app prints "Result:" and then a newline.
        if (text.includes('Result:')) {
            const resultMatch = text.match(/Result: (.*)/);
            const result = resultMatch ? resultMatch[1].trim() : 'Could not parse result.';
            
            res.json({
                filePath,
                recognition: result,
            });

            // Cleanup
            whisperProcess.stdout.removeListener('data', resultListener);
            isBusy = false;
        }
    };
    
    whisperProcess.stdout.on('data', resultListener);
    
    // Add a timeout in case the C++ process never responds
    setTimeout(() => {
        if (isBusy) { // Check if we are still waiting
            whisperProcess.stdout.removeListener('data', resultListener);
            isBusy = false;
            res.status(504).json({ error: 'Request timed out.' });
        }
    }, 120000); // 2-minute timeout

    // Write the file path to the stdin of the C++ process
    whisperProcess.stdin.write(filePath + '\n');
});

app.listen(port, () => {
    console.log(`Node.js server listening at http://localhost:${port}`);
    startWhisperProcess();
});
