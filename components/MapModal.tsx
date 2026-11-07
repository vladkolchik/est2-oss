
import React, { useMemo } from 'react';
import type { Location, PointOfInterest } from '../types';

interface MapModalProps {
  playerLocation: Location;
  discoveredLocations: PointOfInterest[];
  onClose: () => void;
}

const MapModal: React.FC<MapModalProps> = ({ playerLocation, discoveredLocations, onClose }) => {
  const mapData = useMemo(() => {
    if (!discoveredLocations || discoveredLocations.length === 0) {
      return null;
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

    discoveredLocations.forEach(({ coordinates: { x, y } }) => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    });
    
    // Add some padding around the edges
    minX -= 2;
    maxX += 2;
    minY -= 2;
    maxY += 2;

    const width = maxX - minX + 1;
    const height = maxY - minY + 1;

    return { minX, minY, width, height };
  }, [discoveredLocations]);

  if (!mapData) {
    return null; // Or some fallback
  }

  const { minX, minY, width, height } = mapData;

  const getGridPosition = (x: number, y: number) => {
    // CSS grid is 1-based, and we need to flip the Y-axis so positive Y is up
    return {
      gridColumnStart: x - minX + 1,
      gridRowStart: height - (y - minY),
    };
  };

  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 backdrop-blur-sm p-4" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="map-title">
      <div className="w-full max-w-5xl h-[90vh] border-2 border-[#15ff00]/50 p-6 bg-black/95 flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-4 flex-shrink-0">
          <h2 id="map-title" className="text-4xl">WORLD MAP - MOJAVE WASTELAND</h2>
          <button onClick={onClose} className="text-3xl px-3 py-1 border-2 border-transparent hover:border-[#15ff00]/50 transition-colors" aria-label="Close Map">
            &times;
          </button>
        </div>
        <div className="flex-grow overflow-auto p-4 bg-black/50 border border-[#15ff00]/20 relative">
          <div
            className="grid transition-all duration-300 relative mx-auto"
            style={{
              gridTemplateColumns: `repeat(${width}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${height}, minmax(0, 1fr))`,
              backgroundImage: 'linear-gradient(to right, #15ff001a 1px, transparent 1px), linear-gradient(to bottom, #15ff001a 1px, transparent 1px)',
              backgroundSize: '2rem 2rem',
              width: `${width * 2}rem`,
              height: `${height * 2}rem`,
              minWidth: '100%',
              minHeight: '100%',
              aspectRatio: `${width} / ${height}`
            }}
          >
            {discoveredLocations.map((poi, index) => {
              const isPlayer = poi.coordinates.x === playerLocation.coordinates.x && poi.coordinates.y === playerLocation.coordinates.y;
              return (
                <div
                  key={`${poi.name}-${index}`}
                  className="w-full h-full flex items-center justify-center relative group"
                  style={getGridPosition(poi.coordinates.x, poi.coordinates.y)}
                >
                  <div
                    className={`w-3 h-3 rounded-full ${isPlayer ? 'bg-yellow-300 animate-pulse ring-2 ring-yellow-300' : 'bg-[#15ff00]'}`}
                    style={{boxShadow: isPlayer ? '0 0 10px #fde047' : '0 0 8px #15ff00'}}
                  ></div>
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-max bg-black border border-[#15ff00]/50 p-2 text-base z-20 pointer-events-none opacity-0 invisible group-hover:visible group-hover:opacity-100 transition-opacity">
                    <p className="font-bold">{poi.name}</p>
                    <p className="opacity-80">({poi.coordinates.x}, {poi.coordinates.y})</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
         <div className="text-center mt-4 flex-shrink-0 text-lg opacity-80">
            <div className="flex items-center justify-center gap-6">
                <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-yellow-300"></div>
                    <span>Current Location</span>
                </div>
                <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-[#15ff00]"></div>
                    <span>Discovered</span>
                </div>
            </div>
        </div>
      </div>
    </div>
  );
};

export default MapModal;