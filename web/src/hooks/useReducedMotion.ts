import {useEffect, useLayoutEffect, useState} from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

export function useReducedMotion(): boolean {
  // Starts false so the pre-rendered HTML and the first client render match;
  // the layout effect reads the real setting before the first paint.
  const [reduced, setReduced] = useState(false);

  useLayoutEffect(() => setReduced(window.matchMedia(QUERY).matches), []);

  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}
