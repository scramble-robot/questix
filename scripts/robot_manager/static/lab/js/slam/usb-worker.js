import { BrowserSlam } from './usb-slam-core.js';
const slam = new BrowserSlam();
self.onmessage = ({ data: scan }) => {
  const result = slam.process(scan);
  self.postMessage({
    result,
    pose: slam.pose,
    path: slam.path,
    grid: slam.grid,
    size: slam.size,
    resolution: slam.res,
    accepted: slam.accepted,
    rejected: slam.rejected,
  });
};
