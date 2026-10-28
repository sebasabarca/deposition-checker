-- Separate database for the test suite, which drops and recreates its tables on every run.
-- Development data in deposition_checker is never touched by tests.
CREATE DATABASE deposition_checker_test;
