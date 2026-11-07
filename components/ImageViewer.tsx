
import React from 'react';

interface ImageViewerProps {
  imageUrl: string | null;
  isLoading: boolean;
  isEnabled: boolean;
  error: string | null;
}

const ImageViewer: React.FC<ImageViewerProps> = ({ imageUrl, isLoading, isEnabled, error }) => {
  if (error) {
    return (
        <div className="aspect-video w-full border-2 border-red-500/50 p-4 bg-black/50 mb-4 flex items-center justify-center text-center">
             <div>
                <p className="text-xl text-red-500 text-glow mb-2">[ VISUAL FEED ERROR ]</p>
                <p className="text-base text-red-400/80">{error}</p>
             </div>
        </div>
    );
  }

  if (!isEnabled) {
    return (
        <div className="aspect-video w-full border-2 border-[#15ff00]/50 p-4 bg-black/50 mb-4 flex items-center justify-center">
             <p className="text-xl opacity-50">[ VISUAL FEED DISABLED ]</p>
        </div>
    );
  }

  return (
    <div className="aspect-video w-full border-2 border-[#15ff00]/50 bg-black/50 mb-4 flex items-center justify-center relative overflow-hidden">
        {isLoading && (
             <div className="text-center">
                <div className="w-6 h-6 border-4 border-dashed border-[#15ff00] rounded-full animate-spin mx-auto"></div>
                <p className="mt-3 text-lg animate-pulse text-glow">ACQUIRING VISUAL DATA...</p>
            </div>
        )}
        {!isLoading && imageUrl && (
             <img 
                src={imageUrl} 
                alt="Generated scene from the wasteland" 
                className="w-full h-full object-cover animate-fade-in" 
             />
        )}
        {!isLoading && !imageUrl && (
             <p className="text-xl opacity-50">[ AWAITING SIGNAL ]</p>
        )}
    </div>
  );
};

export default ImageViewer;
