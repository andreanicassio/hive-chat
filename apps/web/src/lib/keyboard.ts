/**
 * Quanto spazio si prende la tastiera a schermo.
 *
 * Su telefono la tastiera non riduce l'altezza della pagina: si sovrappone.
 * `dvh` non la vede, quindi un foglio alto 76dvh resta alto 76dvh e la
 * tastiera gli si siede sopra — spariscono i campi e, quel che è peggio, il
 * bottone che salva. È esattamente quello che succedeva aprendo l'editor di
 * un agente da iPhone.
 *
 * L'unica fonte che la conosce è `visualViewport`: la differenza fra la sua
 * altezza e quella della finestra È la tastiera. La scriviamo in una
 * variabile CSS, e il resto lo fa il foglio di stile.
 */
export function trackKeyboard(): void {
  const vv = window.visualViewport;
  if (!vv) return;

  const apply = () => {
    // `offsetTop` conta quando la pagina viene spinta in su dallo zoom sul
    // campo a fuoco: senza, si sottrarrebbe due volte.
    const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    // Sotto i 120px non è una tastiera: è la barra degli indirizzi che si
    // ritrae, e reagire a quella farebbe saltare il layout mentre scorri.
    document.documentElement.style.setProperty('--kb', overlap > 120 ? `${overlap}px` : '0px');
  };

  apply();
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
}
