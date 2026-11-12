# Rediseño visual de RASTREADOC

Rediseño del proyecto existente con Next.js, React y CSS, basado en la referencia
facilitada por el usuario. Conserva el logotipo R/RASTREADOC y las rutas actuales.
No incorpora dependencias, fuentes externas ni logotipos adicionales.

## Presentación

- Menú lateral grafito, iconos blancos y sección activa dorada.
- Barra superior con usuario/rol reales y el mismo cierre de sesión.
- Navegación secundaria con las mismas secciones y opciones por perfil.
- Tarjetas blancas, fondo gris cálido, bordes suaves y acentos dorados.
- Estilo compartido para Panel, Alta, Boletas, Escanear, Buscar, Reportes,
  Archivados, Catálogos y Usuarios; también para acceso, carga y diálogos.
- Menú plegable en teléfono/tablet, controles amplios y tablas con desplazamiento
  horizontal dentro de su contenedor. El contenido no pierde columnas.
- Los avisos de expediente permanecen bajo Guardar expediente.

Paleta principal: grafito #303034, blanco #FFFFFF, fondo #F5F4F3, dorado #B89568,
texto #242428 y bordes #E2E0DE. Los colores de éxito/error conservan su significado.

## Datos y controles de la referencia

Los indicadores usan la lista actual de documentos: total, Autorizados y
Enviados. No se copia el número ni se inventa una definición de «En trámite».

El buscador superior reubica el filtro existente de Buscar, con su mismo valor
y comportamiento. Se habilita en esa sección; en las demás indica dónde está
disponible. No incorpora una búsqueda global, de folios ni un atajo Ctrl+K.

La campana es un indicador visual del seguimiento vencido que ya calcula el
sistema. El contador aparece únicamente si existen documentos en esas alertas;
no se añade un centro de notificaciones o información simulada.

Se conservan los filtros automáticos y las acciones Imprimir, Exportar a Excel y
Ver PDF. No se añade el botón Generar reporte de la imagen: los reportes siguen
respondiendo a los filtros actuales. La tabla completa continúa disponible.

## Archivos

| Archivo | Propósito |
| --- | --- |
| app/redesign.css | Paleta, componentes visuales compartidos y adaptación responsive. |
| app/components/brand.js | Reutilización del logotipo existente, una sola vez por pantalla. |
| app/components/ui.js | Iconos SVG decorativos y botones que conservan las propiedades nativas. |
| app/components/workspace-shell.js | Menú lateral, cabecera, indicadores y navegación responsive. |
| app/layout.js | Importación del tema y ubicación del logotipo a través de los componentes. |
| app/home-page.js | Integración de la presentación y reubicación del filtro existente. |
| tests/document-operations-browser.py | Regresiones y comprobaciones de navegación, perfiles y pantallas. |
| REVISION_OPERATIVA.md | Registro de alcance y validación. |

## Conservación de funciones

No cambia Supabase, SQL, políticas, usuarios, claves, variables de entorno,
dependencias, rutas ni módulos de operaciones/creación/QR. Los manejadores de
autenticación, carga, guardado e impresión se compararon con la versión publicada
ece47bd y conservan su código. Las modificaciones del componente de página se
limitan a presentación, iconos, indicadores de datos existentes y el filtro movido.

Los controles mantienen sus tipos de botón, eventos, etiquetas y bloqueos de
guardado/verificación. Se conserva la memoria de los formularios al cambiar de
sección, los conflictos entre capturas y los resultados inciertos.

## Revisión

Validación realizada con datos ficticios:

- 67 pruebas JavaScript y 45 de navegador aprobadas, incluidos guardados,
  verificación incierta, conflictos, búsqueda, reportes, impresión y QR.
- Recorrido de las nueve secciones; navegación de administrador, supervisor,
  empleado y consulta; contadores basados en datos y conservación de formularios.
- Pantallas de 1774 × 1000, 1280 × 720, 390 × 844, 412 × 915 y 768 × 1024.
  Los recorridos de teléfono/tablet comprueban ausencia de desbordamiento general,
  cierre del menú, acceso a las secciones y conservación de borradores.
- Revisión visual de capturas de Reportes, Alta, Panel, Escanear, Catálogos y
  Usuarios. Tras equilibrar la cuadrícula del Panel se repitieron los cuatro
  casos visuales, todos aprobados.
- Lint sin errores; se conserva la advertencia anterior de la imagen QR.
- Compilación de producción de Next.js correcta, con las mismas rutas que antes.
- No se repitieron las pruebas SQL porque no cambia la base ni el código SQL.

La rama de trabajo es codex/rediseno-visual-rastreadoc. El Preview se publica en
codex/rastreadoc-pruebas, que conserva la conexión al proyecto Free aislado.
Producción permanece en la versión anterior mientras se revisa el diseño.

Abrir el último Preview Ready de esa rama en Vercel, recargar con Ctrl+F5 y usar
la cuenta de pruebas. Recorrer las nueve secciones y revisar también una ventana
estrecha. Las capturas automatizadas usan exclusivamente datos ficticios.

Alias: https://rastreodoc-git-codex-rastreadoc-pruebas-jasg.vercel.app/

Las verificaciones responsive emulan escritorio, teléfono y tablet en Chromium;
no equivalen a pruebas realizadas en dispositivos físicos Android/iPhone.
