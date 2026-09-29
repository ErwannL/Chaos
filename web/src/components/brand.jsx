import { useI18n } from '../i18n.jsx';

// Même habillage que Figura / Vigie / SportSplitter « by Orqea » : crédits du propriétaire et de l'auteur.
export const ORQEA_URL = 'https://orqea.dev';
export const AUTHOR_URL = 'https://github.com/ErwannL';

/**
 * Le logo : statique, remplacé par le logo animé au survol (CSS pur, `.logo-hover` dans
 * index.css) ; sous `prefers-reduced-motion` l'échange est coupé. `animated` : animé en
 * continu (un run est en cours), comme un indicateur.
 */
export function HoverLogo({ className = '', animated = false }) {
  return (
    <span className={`logo-hover ${className}`} data-animated={animated ? 'true' : undefined}>
      <img src="/logo.svg" alt="" className="logo-static h-full w-full" />
      <img src="/logo-animated.svg" alt="" className="logo-animated h-full w-full" />
    </span>
  );
}

/** « Propulsé par Orqea » (même onglet, cadre du haut) et « Développé par Erwann Laplante ». */
export function Credits({ className = '' }) {
  const { t } = useI18n();
  return (
    <span className={`flex gap-2 text-xs text-neutral-500 ${className}`}>
      <a href={ORQEA_URL} target="_top" data-credit="owner">
        {t('poweredBy')}
      </a>
      <a
        href={AUTHOR_URL}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={t('authorNewTab')}
        data-credit="author"
      >
        {t('author')}
      </a>
    </span>
  );
}
