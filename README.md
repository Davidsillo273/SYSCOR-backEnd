# SYSCOR — Sistema de Gestión Integral para Taquería El Corral

SYSCOR es una solución tecnológica desarrollada a medida para optimizar y modernizar las operaciones administrativas, contables y comerciales de Taquería El Corral. El sistema combina una plataforma web de gestión interna con una aplicación móvil orientada al cliente final, resultado de un proceso formal de levantamiento de requerimientos y entrevistas directas con la administración del negocio.

## Tabla de Contenidos

- [Descripción General](#descripción-general)
- [Funcionalidades](#funcionalidades)
- [Tecnologías Utilizadas](#tecnologías-utilizadas)
- [Estructura del Proyecto](#estructura-del-proyecto)
- [Instalación y Configuración](#instalación-y-configuración)
- [Variables de Entorno](#variables-de-entorno)
- [Roles del Sistema](#roles-del-sistema)
- [Licencia](#licencia)

## Descripción General

El proyecto surge como respuesta a los desafíos operativos identificados en Taquería El Corral: desorden en el registro de compras, dificultades en la gestión del personal, pérdida de ventas en horarios de alta demanda, y ausencia de herramientas para la administración de eventos. SYSCOR centraliza estas áreas en un sistema unificado, reduciendo errores humanos y mejorando la eficiencia general del negocio.

> El sistema fue desarrollado utilizando convención **camelCase** en nombres de variables, funciones y campos de base de datos.

## Funcionalidades

### Control de Compras e IVA
- Procesamiento unificado de facturas en formato JSON y PDF
- Identificación y seguimiento de documentos procesados para libros de IVA
- Comparación exacta de datos para eliminación de errores contables
- Generación de reportes para comunicación con el contador

### Gestión de Personal y Planilla
- Registro de empleados con datos personales, DUI y NIT
- Control de pagos adicionales, asuetos y descuentos de ley
- Cálculo automatizado de deducciones AFP e ISSS
- Generación de planilla con trazabilidad completa

### Pedidos en Línea — Aplicación Móvil
- Visualización del menú con fotografías y descripción de productos
- Sistema de pedidos para retiro en local
- División automática de comandas por área: bebidas, comida general y especialidades mexicanas

### Pagos en Línea
- Integración con la pasarela de pago Wompi

### Reservación de Eventos
- Módulo de reserva para eventos especiales en el local
- Control de detalles operativos: mantelería, prioridad en atención y capacidad

## Tecnologías Utilizadas

### Backend
- Node.js
- Express.js 5
- MongoDB / Mongoose

### Frontend Web
- React.js

### Aplicación Móvil
- React Native

### Autenticación y Seguridad
- JSON Web Tokens (JWT)
- Bcrypt

### Servicios Externos
- Nodemailer (notificaciones por correo)
- Wompi (pagos en línea)
- Cloudinary (almacenamiento y gestión de imágenes)

## Dependencias del Proyecto

### Backend (`backEnd/package.json`)

| Paquete | Versión | Uso |
|---|---|---|
| `express` | ^5.2.1 | Framework del servidor HTTP |
| `mongoose` | ^9.6.3 | ODM para MongoDB |
| `bcryptjs` | ^3.0.3 | Hash de contraseñas |
| `jsonwebtoken` | ^9.0.3 | Generación y verificación de tokens JWT |
| `cookie-parser` | ^1.4.7 | Parseo de cookies (manejo de tokens httpOnly) |
| `cors` | ^2.8.6 | Habilitación de CORS para frontends |
| `dotenv` | ^17.4.2 | Carga de variables de entorno |
| `nodemailer` | ^8.0.10 | Envío de correos (verificación, recuperación de contraseña) |
| `cloudinary` | ^1.41.3 | Almacenamiento de imágenes en la nube |
| `multer` | ^2.1.1 | Manejo de subida de archivos (multipart/form-data) |
| `multer-storage-cloudinary` | ^4.0.0 | Conector entre Multer y Cloudinary |
| `crypto` | ^1.0.1 | Generación de códigos de verificación |
| `storage` | ^0.2.0 | Utilidades de almacenamiento |

**Dependencias de desarrollo:**

| Paquete | Versión | Uso |
|---|---|---|
| `nodemon` | ^3.1.14 | Reinicio automático del servidor en desarrollo |

## Estructura del Proyecto

```
syscor/
├── backEnd/
│   ├── controllers/
│   │   ├── auth/
│   │   │   ├── admins/
│   │   │   ├── customers/
│   │   │   ├── employees/
│   │   │   ├── logoutController.js
│   │   │   └── recoveryPasswordController.js
│   │   ├── users/
│   │   ├── menu/
│   │   ├── orders/
│   │   └── inventory/
│   ├── models/
│   ├── routes/
│   ├── utils/
│   ├── config/
│   ├── index.js
│   └── package.json
├── frontEndAdmin/
├── frontEndEmployee/
└── frontEndClient/
```

## Instalación y Configuración

### Prerrequisitos

- Node.js v18 o superior
- MongoDB (local o Atlas)
- npm

### 1. Clonar el repositorio

```bash
git clone https://github.com/Davidsillo273/SYSCOR.git
cd SYSCOR
```

### 2. Configurar el backend

```bash
cd backEnd
npm install
```

Crear el archivo `.env` en `backEnd/` (ver sección [Variables de Entorno](#variables-de-entorno)).

Levantar el servidor en modo desarrollo (con recarga automática vía `nodemon`):

```bash
npm run dev
```

El servidor backend corre por defecto en `http://localhost:PORT` según el valor definido en `.env`.

### 3. Configurar el frontend de Administrador

```bash
cd frontEndAdmin
npm install
npm run dev
```

### 4. Configurar el frontend de Empleado

```bash
cd frontEndEmployee
npm install
npm run dev
```

### 5. Configurar la aplicación móvil de Cliente

```bash
cd frontEndClient
npm install
npm run dev
```

## Variables de Entorno

Crear un archivo `.env` dentro de `backEnd/` con las siguientes variables:

```env
# Servidor
PORT=4000

# Base de datos
MONGODB_URI=mongodb+srv://usuario:password@cluster.mongodb.net/syscor

# JWT
JWT_Secret_key=tu_secreto_jwt_aqui
# Llave aparte para los tokens de las pantallas de cocina (KDS). Opcional:
# si falta se deriva de JWT_Secret_key, pero en producción conviene definirla.
JWT_DEVICE_SECRET_KEY=otro_secreto_para_pantallas_de_cocina

# Correo (Nodemailer - Gmail)
EMAIL_USER=tu_correo@gmail.com
EMAIL_PASSWORD=tu_contraseña_de_aplicacion

# Cloudinary
CLOUDINARY_CLOUD_NAME=tu_cloud_name
CLOUDINARY_API_KEY=tu_api_key
CLOUDINARY_API_SECRET=tu_api_secret

# Wompi
GRANT_TYPE=tu_llave_publica_wompi
AUDIENCE=
CLIENT_ID==tu_llave_privada_wompi
CLIENT_SECRET=tu_secreto_de_eventos_wompi
```

>  El archivo `.env` nunca debe subirse al repositorio. Verificar que esté incluido en `.gitignore`.

## Roles del Sistema

| Rol | Descripción |
|---|---|
| **Administrador** | Acceso completo a todos los módulos de gestión |
| **Empleado** | Gestión de pedidos, comandas y atención al cliente |
| **Cliente** | Consulta de menú, pedidos en línea y reservación de eventos |

## Licencia
<img width="800" height="800" alt="image" src="https://github.com/user-attachments/assets/d0112078-f0b1-41ee-92ac-a0ef172ba244" />

Proyecto desarrollado como propuesta tecnológica para Taquería El Corral. Todos los derechos reservados.
