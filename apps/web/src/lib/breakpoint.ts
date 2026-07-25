import { useEffect, useState } from 'react';

/**
 * Sotto questa soglia l'interfaccia è quella del telefono.
 *
 * 768px non è una misura di dispositivo ma di layout: è il punto in cui le due
 * colonne (barra laterale + conversazione) smettono di starci senza schiacciare
 * il testo. Sopra si affiancano, sotto si impilano e si naviga.
 */
const MOBILE_MAX = 767;

const QUERY = `(max-width: ${MOBILE_MAX}px)`;

export function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(QUERY).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener('change', onChange);
    // Fra il primo render e qui la finestra può essere già cambiata
    // (rotazione, ripristino della sessione a una dimensione diversa).
    onChange();
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return mobile;
}
