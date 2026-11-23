# Acceso autorizado a RASTREADOC

Esta actualización exige un perfil de oficina real antes de cargar información o administrar usuarios. Un error al comprobar permisos deniega el acceso; no asigna un administrador por defecto. La sesión se valida en el servidor, sin confiar en el rol enviado por el navegador ni en metadatos de registro.

La migración `supabase/migrations/20261123_office_access.sql` añade políticas RLS restrictivas que exigen un perfil en las nueve tablas de trabajo, limita la visibilidad de perfiles, impide editar permisos desde clientes y verifica perfiles también en las funciones que ejecutan con permisos del servidor. No crea cuentas, elimina registros ni altera códigos QR. Las funciones conservan sus firmas e idempotencia.

Permisos conservados: administrador y supervisor administran usuarios, corrigen y archivan; empleado captura y registra movimientos; consulta consulta información. Todos los perfiles de oficina conservan la restauración de archivados. La edición de documentos e historial se realiza mediante las funciones existentes; la actualización directa queda limitada al campo de archivado.

Se añaden cabeceras contra la inclusión del sistema en marcos de terceros, detección insegura de contenidos y referencias de navegación innecesarias. La CSP inicial limita marcos, objetos y URL base; no incorpora una política completa de scripts. La cámara, la generación de QR y las ventanas de impresión mantienen su funcionamiento.

## Preparación y revisión

1. Desactivar **Allow new users to sign up** en Authentication de Supabase. Mantener el inicio de sesión por correo. Los usuarios existentes y el alta administrativa siguen disponibles.
2. Comprobar en SQL Editor que la cuenta del responsable tenga un perfil explícito de administrador o supervisor. Revisar las demás cuentas y los perfiles ausentes, sin aprobar desconocidos automáticamente. `scripts/revision-seguridad.sql` consulta únicamente recuentos y metadatos de permisos.
3. Aplicar únicamente la nueva migración en el proyecto de pruebas. No ejecutar todo el esquema ni migraciones históricas sobre una base existente. La migración es transaccional, se puede repetir y rechaza la instalación si existen cuentas pero ningún administrador/supervisor con perfil.
4. Revisar Preview con el usuario de pruebas: ingreso, captura, consulta, reportes, QR, impresión y archivados. Las pruebas automáticas emplean cuentas y registros ficticios en servicios locales; no acceden a la base de la oficina.
5. Después de la revisión y aprobación, publicar primero el código de servidor en producción. Confirmar el despliegue y el acceso del responsable. Luego aplicar la migración nueva en el Supabase de producción y ejecutar la consulta de revisión. Cerrar el registro por sí solo no invalida cuentas que ya existan; las restricciones de base de datos son necesarias.

No aplicar la migración mientras siga publicado el servidor anterior que asignaba permisos por defecto. No promover el artefacto Preview: producción necesita recompilar con sus propias variables de entorno. No trasladar claves ni contraseñas al repositorio.

## Recuperación

Punto de restauración previo: etiqueta `respaldo/antes-seguridad-2026-11-23`, revisión `b325ca0e9f401f9b54e60a29c3da27371b56c053`. Recuperar el diseño/código anterior también recuperaría el fallo de autorización: no utilizarlo como solución permanente de un problema de acceso. Ante un bloqueo, revisar el perfil y corregir el cambio concreto mediante administración de Supabase, conservando el cierre de registro y las restricciones. No eliminar políticas de protección ni asignar perfiles a todas las cuentas.

## Límites y siguientes etapas

La protección real requiere instalar tanto el código como la migración y verificar los ajustes de Supabase. Esta actualización no demuestra ausencia de accesos anteriores ni constituye una auditoría completa. Quedan para una etapa posterior la verificación de MFA de las cuentas de infraestructura, políticas de contraseñas/sesiones, inventario de cuentas, registros de acceso y alertas. El respaldo diario ayuda a recuperar información; no reemplaza los controles de acceso.

## Validación de esta revisión

El 23 de noviembre de 2026 pasaron 81 pruebas de JavaScript, 55 de PostgreSQL local y 63 de navegador: 199 en total. Incluyen bloqueo por perfil ausente, fallo de permisos, revocación, permisos administrativos del servidor, políticas antiguas permisivas, operaciones atómicas, captura, QR, impresión, reportes y vistas de escritorio/tablet/teléfono. La compilación de producción terminó correctamente. ESLint no reportó errores; conserva la advertencia previa del elemento de imagen QR.

Se comprobó por lectura de los ajustes públicos de Supabase que el registro de nuevos usuarios está cerrado y el acceso por correo continúa activo. Esto no verifica los perfiles, las políticas ni las sesiones existentes de producción. La consulta del responsable, la revisión de Preview y la instalación de la migración en Supabase aún requieren comprobación administrativa.
