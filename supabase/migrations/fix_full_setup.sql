-- ============================================================
-- CLINICA DEL SOL — Setup completo de base de datos y RLS
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- 1. Crear tabla profiles (si no existe)
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL,
  nombre TEXT NOT NULL,
  apellido TEXT NOT NULL,
  especialidad TEXT NOT NULL,
  matricula TEXT,
  firma TEXT
);

-- 2. Crear tabla patient_records (si no existe)
CREATE TABLE IF NOT EXISTS public.patient_records (
  dni TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Habilitar RLS en ambas tablas
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.patient_records ENABLE ROW LEVEL SECURITY;

-- 4. Limpiar políticas existentes para evitar conflictos
DROP POLICY IF EXISTS "Usuarios pueden ver su propio perfil" ON public.profiles;
DROP POLICY IF EXISTS "Administradores pueden ver todos los perfiles" ON public.profiles;
DROP POLICY IF EXISTS "Administradores pueden actualizar perfiles" ON public.profiles;
DROP POLICY IF EXISTS "Usuarios autenticados pueden ver todos los perfiles" ON public.profiles;
DROP POLICY IF EXISTS "Usuarios autenticados pueden leer pacientes" ON public.patient_records;
DROP POLICY IF EXISTS "Usuarios autenticados pueden insertar pacientes" ON public.patient_records;
DROP POLICY IF EXISTS "Usuarios autenticados pueden actualizar pacientes" ON public.patient_records;

-- ============================================================
-- POLÍTICAS PARA: public.profiles
-- ============================================================

-- Un usuario puede ver su propio perfil (necesario para el login)
CREATE POLICY "Usuarios pueden ver su propio perfil"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

-- Un administrador puede ver todos los perfiles (necesario para el panel admin)
CREATE POLICY "Administradores pueden ver todos los perfiles"
  ON public.profiles FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.especialidad = 'Administrador'
    )
  );

-- Un administrador puede actualizar cualquier perfil (necesario para editar usuarios)
CREATE POLICY "Administradores pueden actualizar perfiles"
  ON public.profiles FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.especialidad = 'Administrador'
    )
  );

-- ============================================================
-- POLÍTICAS PARA: public.patient_records
-- Todos los usuarios autenticados pueden leer y escribir registros
-- de pacientes (compartidos entre todo el personal)
-- ============================================================

CREATE POLICY "Usuarios autenticados pueden leer pacientes"
  ON public.patient_records FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "Usuarios autenticados pueden insertar pacientes"
  ON public.patient_records FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

CREATE POLICY "Usuarios autenticados pueden actualizar pacientes"
  ON public.patient_records FOR UPDATE
  USING (auth.role() = 'authenticated');
