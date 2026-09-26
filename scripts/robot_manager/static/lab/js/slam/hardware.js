import { loadText } from '../core/content.js';

// What the learner reads and downloads for the real-robot SLAM experiment.
const [html, guide, python] = await Promise.all([
  loadText('content/slam/hardware-steps.html'),
  loadText('content/slam/ros2-procedure.md'),
  loadText('content/slam/robo_lab_record.py'),
]);
const HARDWARE = { html, guide, python };

export { HARDWARE };
