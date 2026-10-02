import { Membrete } from '../ui/kit';
import { HojaCloudflare } from '../components/conexiones/HojaCloudflare';
import { HojaTokens } from '../components/conexiones/HojaTokens';

/**
 * Conexiones con otros sistemas: Cloudflare (DNS automático) y tokens de
 * gestión para Skyway, scripts o agentes. Cada hoja es autónoma.
 */
export default function Conexiones({ isAdmin }: { isAdmin: boolean }) {
  // El membrete ya trae su separación inferior: dentro del contenedor con
  // «gap» sumaba el doble de mesa que en el resto de vistas.
  return (
    <>
      <Membrete
        title="Conexiones"
        meta={
          isAdmin
            ? 'Cloudflare para configurar el DNS sin copiar registros, y tokens para gestionar Mailway desde Skyway u otras herramientas.'
            : 'Cloudflare para configurar el DNS de tus dominios sin copiar registros, y tokens para automatizar la gestión.'
        }
      />
      <div className="flex flex-col gap-4">
        <HojaCloudflare isAdmin={isAdmin} />
        <HojaTokens isAdmin={isAdmin} />
      </div>
    </>
  );
}
