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

/** « Propulsé par Orqea » (même onglet, cadre du haut) et « Développé par Erwann Laplante », empilés. */
export function Credits({ className = '' }) {
  const { t } = useI18n();
  const orqeaUrl = useContext(OrqeaUrl);
  return (
    <span className={`flex flex-col text-xs leading-tight ${className}`}>
      <a
        href={orqeaUrl}
        target="_top"
        data-credit="owner"
        className="font-semibold text-neutral-600 hover:underline dark:text-neutral-300"
      >
        {t('poweredBy')}
      </a>
      <a
        href={AUTHOR_URL}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={t('author')}
        data-credit="author"
        className="text-neutral-500 hover:underline"
      >
        {t('author')}
      </a>
    </span>
  );
}

/**
 * L'en-tête de marque : logo (animé au survol / au focus clavier), « Chaos par Orqea » puis,
 * SOUS le nom, les deux lignes de crédits. `centered` : écran de connexion / avis SSO.
 */
export function Brand({ animated = false, centered = false }) {
  const { t } = useI18n();
  const size = centered ? 'h-20 w-20' : 'h-9 w-9';
  return (
    <div className={`brand flex items-center gap-3 ${centered ? 'flex-col text-center' : 'mr-4'}`}>
      <HoverLogo className={`${size} shrink-0`} animated={animated} />
      <div className={`flex flex-col ${centered ? 'items-center' : ''}`}>
        <h1 className="text-lg font-bold leading-tight">
          Chaos <span className="text-sm font-normal text-neutral-500">{t('byline')}</span>
        </h1>
        <Credits />
      </div>
    </div>
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
