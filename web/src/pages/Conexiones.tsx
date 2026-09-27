import { Membrete } from '../ui/kit';
import { HojaCloudflare } from '../components/conexiones/HojaCloudflare';
import { HojaTokens } from '../components/conexiones/HojaTokens';

/**
 * Conexiones con otros sistemas: Cloudflare (DNS automático) y tokens de
 * gestión para Skyway, scripts o agentes. Cada hoja es autónoma.
 */
export default function Conexiones({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      <Membrete
        title="Conexiones"
        meta={
          isAdmin
            ? 'Cloudflare para configurar el DNS sin copiar registros, y tokens para gestionar Mailway desde Skyway u otras herramientas.'
            : 'Cloudflare para configurar el DNS de sus dominios sin copiar registros, y tokens para automatizar la gestión.'
        }
      />
      <HojaCloudflare isAdmin={isAdmin} />
      <HojaTokens isAdmin={isAdmin} />
    </div>
  );
}
