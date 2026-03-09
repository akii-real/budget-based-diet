import { useRef, FC, useEffect, useState } from 'react';

import { CanvasContext } from '../hooks/useCanvas';
import useResponsiveSize from '../hooks/useResponsiveSize';
import Wave from './Wave';

const Canvas: FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { width } = useResponsiveSize();
  const [context, setContext] = useState<
    CanvasRenderingContext2D | undefined
  >();
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true); // Ensures this runs only on the client
  }, []);

  useEffect(() => {
    if (!isClient || !canvasRef.current) return;

    // Prevent duplicate canvas creation
    const canvasElements = document.querySelectorAll('#canvas');
    if (canvasElements.length > 1) {
      const extraCanvas = canvasElements[1]; // Get second canvas safely
      if (extraCanvas) extraCanvas.remove(); // Remove only if it exists
    }

    const ctx = canvasRef.current.getContext('2d');
    if (ctx) setContext(ctx);
  }, [isClient]);

  return (
    <CanvasContext.Provider value={{ context }}>
      <canvas id="canvas" ref={canvasRef} width={width} height={220}></canvas>
      <Wave />
    </CanvasContext.Provider>
  );
};

export default Canvas;
