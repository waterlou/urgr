import { createContext, useContext, useState, useEffect } from 'react';
import { getPlatforms } from '../api.js';

const PlatformContext = createContext(null);

export function PlatformProvider({ children }) {
  const [platforms, setPlatforms] = useState([]);

  useEffect(() => {
    getPlatforms().then(setPlatforms).catch(() => {});
  }, []);

  return (
    <PlatformContext.Provider value={platforms}>
      {children}
    </PlatformContext.Provider>
  );
}

export function usePlatforms() {
  return useContext(PlatformContext);
}
