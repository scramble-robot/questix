import { loadText } from '../core/content.js';

// Downloads offered by the vision course: the real-robot procedure and two read-only recorders.
const [VISION_ROS_GUIDE, VISION_ROS_SCRIPT, VISION_RGBD_SCRIPT] = await Promise.all([
  loadText('content/vision/ros2-procedure.md'),
  loadText('content/vision/robo_lab_camera_capture.py'),
  loadText('content/vision/robo_lab_rgbd_capture.py'),
]);

export { VISION_ROS_GUIDE, VISION_ROS_SCRIPT, VISION_RGBD_SCRIPT };
