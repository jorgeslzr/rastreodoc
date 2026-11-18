# Identidad visual carbón y dorado

Preparada el 18 de noviembre de 2026 sobre la versión publicada `b8fdc86`, que
incluye el filtro por dependencia y todas las entregas anteriores.

## Punto de restauración, creado antes de los cambios

- Commit anterior: `b8fdc861b26112f5e5cd4770d7974f8a747e1c48`.
- Etiqueta anotada y guardada en GitHub:
  `respaldo/antes-identidad-2026-11-18`.
- Copia del código anterior:
  `/workspace/setup-rastreodoc/diseno-anterior-2026-11-18.tar.gz`.
- Capturas anteriores con datos ficticios:
  `/workspace/setup-rastreodoc/identidad-antes-2026-11-18/`.

Para volver a la apariencia anterior se debe crear una rama desde la versión
vigente y revertir el commit de identidad, revisando posibles cambios posteriores.
No hacer un reset de producción ni restaurar una base de datos: el cambio es de
presentación. La etiqueta permite consultar exactamente los archivos anteriores.

## Resultado

- Logotipo adaptado a partir de la imagen adjunta: emblema R, separador,
  RASTREADOC y CONTROL DOCUMENTAL. Se preparó un recurso gráfico limpio sobre
  carbón. El archivo mantiene su proporción; el recorte de presentación se hace
  en CSS, sin estirar la imagen. Next Image sirve versiones optimizadas y reutiliza
  el mismo recurso para el logotipo completo y la R compacta.
- Menú lateral carbón; elementos activos y acciones principales dorados con
  texto carbón. Las áreas de captura y consulta siguen claras, con fondo marfil,
  tarjetas blancas, bordes discretos y tablas con alternancia suave.
- Entre 901 y 1199 px, el menú se presenta como barra compacta con la R e iconos,
  conservando nombres accesibles y etiquetas al colocar el puntero. En teléfonos
  y tablet vertical se mantiene el menú desplegable existente y la R en la barra
  superior; al abrir el menú se ve el logotipo completo.
- Los estatus conservan sus nombres y valores. Se complementan con colores
  semánticos distintos para recibido/listo, enviado, autorizado, rechazado y
  reingresado, sin cambiar ningún proceso.

## Paleta centralizada

`app/theme.css` define carbón `#202020`, grafito `#303033`, dorado `#BE9B68`,
hover dorado claro `#D7BA8B` y marfil `#F8F6F2`, además de neutros, estados y
variantes legibles. Los botones principales usan texto carbón sobre dorado con
contraste superior a 4.5:1. Los estados conservan también una etiqueta de texto.

## Archivos

- `public/brand/rastreadoc-logo.png`: logotipo para la interfaz.
- `app/components/brand.js`: imagen proporcionada y presentación compacta.
- `app/components/workspace-shell.js`: nombres accesibles y marca compacta.
- `app/theme.css`, `app/redesign.css`, `app/layout.js`: variables y presentación.
- `app/home-page.js`: únicamente atributos y clases de presentación de estatus.
- `tests/document-operations-browser.py`: revisión de identidad y navegación.

La comparación contra `b8fdc86` confirmó que el código previo al retorno de
WorkspaceShell en HomePage permanece idéntico byte por byte: funciones de
negocio, consultas, impresión, autenticación y permisos. No se cambiaron SQL,
registros, rutas, dependencias, campos, filtros ni contenido/formato de QR.

## Revisión y publicación

Revisar primero el [Preview](https://rastreodoc-git-codex-rastreadoc-pruebas-jasg.vercel.app/)
en las nueve secciones, incluyendo el filtro de dependencias y exportaciones.
La publicación en el sistema real requiere la aprobación del usuario sobre esta
entrega. Se hará desde `main` para reconstruir con las variables reales, sin
promover el artefacto de Preview conectado a la base Free. No requiere SQL.

El usuario autorizó expresamente la publicación de esta identidad el 18 de
noviembre de 2026. La versión aprobada y probada es `b24c529`; la documentación
posterior registra esa autorización sin modificar el diseño ni sus funciones.
La comprobación posterior al despliegue debe verificar los scripts públicos,
el backend real, la paleta compilada y el archivo exacto del logotipo.

## Validación completada

- 74 pruebas de JavaScript y 57 de navegador correctas: 131 en total.
- Compilación correcta de las mismas rutas; lint sin errores y con la advertencia
  previa del `<img>` usado para el QR.
- Recorridos de las nueve secciones, roles existentes, captura, movimientos,
  eliminación, filtros por dependencia, CSV/PDF/impresión y recuperación ante
  fallos. Pruebas con API ficticia y sin escrituras a Supabase real.
- Escritorio 1774 px, viewport habitual de laptop 1280 px, tablet 768×1024 y
  1024×768, teléfonos emulados de 320, 390 y 412 px. La emulación es Chromium;
  no sustituye una comprobación física en Safari/iPhone.
- Logo cargado correctamente, contraste del botón principal superior a 4.5:1,
  nombres accesibles conservados en la barra compacta y borradores preservados
  al cambiar de orientación.
- Etiqueta y archivo de restauración verificados contra los archivos originales
  del commit anterior. Paleta compilada verificada con las siete variables
  principales y sus alias.
