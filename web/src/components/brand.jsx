import { createContext, useContext } from 'react';
import { useI18n } from '../i18n.jsx';

// Même habillage que Figura / Vigie / SportSplitter « by Orqea » : crédits du propriétaire et de l'auteur.
export const DEFAULT_ORQEA_URL = 'https://orqea.dev';
/** L'URL d'Orqea de CET environnement (`orqeaUrl` de `/auth/mode`, serveur : CHAOS_ORQEA_URL). */
export const OrqeaUrl = createContext(DEFAULT_ORQEA_URL);
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
  const orqeaUrl = useContext(OrqeaUrl);
  return (
    <span className={`flex gap-2 text-xs text-neutral-500 ${className}`}>
      <a href={orqeaUrl} target="_top" data-credit="owner">
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

/**
 * « Revenir sur Orqea » : la session vient d'Orqea, il n'y a donc pas de déconnexion, on y
 * retourne. Masqué dans l'iframe de la console d'Orqea (la console est déjà le chemin de retour).
 */
export function BackToOrqea() {
  const { t } = useI18n();
  const orqeaUrl = useContext(OrqeaUrl);
  if (window.self !== window.top) return null;
  return (
    <a
      href={orqeaUrl}
      target="_top"
      data-back-to-orqea
      className="rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
    >
      {t('backToOrqea')}
    </a>
  );
}
